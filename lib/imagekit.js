// Backup/failover storage buat foto produk, di samping ImgBB. Dipakai di 3
// tempat: (1) upload dobel otomatis tiap ada foto baru (routes/products.js
// POST /upload-image), (2) failover kalau ImgBB lagi down pas upload, dan
// (3) migrasi foto lama yang masih ImgBB-only (lib/imageMigration.js).
//
// Pakai REST API ImageKit langsung (bukan SDK resminya) -- upload cuma butuh
// 1 endpoint (multipart form-data + Basic Auth pakai private key), jadi gak
// perlu tambah dependency baru. Node 18+ udah nyediain fetch/FormData/Blob
// global bawaan.
const { sendTelegramNotif } = require('./telegram');

const IMAGEKIT_PRIVATE_KEY = process.env.IMAGEKIT_PRIVATE_KEY || '';
const IMAGEKIT_UPLOAD_URL = 'https://upload.imagekit.io/api/v1/files/upload';
// Folder custom biar rapi -- semua foto produk/varian (baik yang baru
// diupload maupun hasil migrasi dari ImgBB) masuk ke sini, bukan numpuk di
// root akun ImageKit.
const IMAGEKIT_FOLDER = (process.env.IMAGEKIT_FOLDER || '/kasir-hk/produk').trim();

// Sama kayak imgbb.js: function Vercel dibatasin 30 detik total (vercel.json),
// jadi retry pertama dikasih jatah lebih pendek, sisanya dipakai buat 1x
// retry kalau masih ada waktu.
const FUNCTION_DEADLINE_MS = 30000;
const FIRST_ATTEMPT_TIMEOUT_MS = 15000;
const SAFETY_MARGIN_MS = 3000;

const ALERT_COOLDOWN_MS = 15 * 60 * 1000;
let lastAlertAt = 0;
function alertImageKitFailure(reason) {
  const now = Date.now();
  if (now - lastAlertAt < ALERT_COOLDOWN_MS) return;
  lastAlertAt = now;
  sendTelegramNotif(`🚨 <b>Upload foto ke ImageKit (backup) gagal</b>\n${reason}\n\nKalau ini terus berulang, cek IMAGEKIT_PRIVATE_KEY (mungkin expired/kena limit).`);
}

function authHeader() {
  return 'Basic ' + Buffer.from(`${IMAGEKIT_PRIVATE_KEY}:`).toString('base64');
}

function randomFileName(ext) {
  const rand = Math.random().toString(36).slice(2, 10);
  return `img-${Date.now()}-${rand}.${ext}`;
}

function extFromDataUrl(base64DataUrl) {
  const m = /^data:image\/(png|jpe?g|webp);base64,/.exec(String(base64DataUrl || ''));
  if (!m) return 'jpg';
  return m[1] === 'jpeg' ? 'jpg' : m[1];
}

// `filePayload` bisa berupa string base64 (dari upload interaktif -- browser
// udah nge-base64-in fotonya lewat FileReader, jadi format itu yang dateng)
// ATAU Buffer mentah (dari migrasi -- backend download bytes-nya langsung
// dari ImgBB, jadi gak perlu bolak-balik encode ke base64 dulu, lebih
// hemat CPU/memori & sedikit lebih cepat berhubung gak ada overhead ~33%
// ukuran data ala base64).
async function doUpload(filePayload, { fileName, folder, tags, timeoutMs, mime }) {
  if (!IMAGEKIT_PRIVATE_KEY) {
    const err = new Error('IMAGEKIT_PRIVATE_KEY belum di-set di environment server');
    err.code = 'IMAGEKIT_NOT_CONFIGURED';
    throw err;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const form = new FormData();
    if (Buffer.isBuffer(filePayload)) {
      form.append('file', new Blob([filePayload], mime ? { type: mime } : undefined), fileName);
    } else {
      form.append('file', filePayload);
    }
    form.append('fileName', fileName);
    form.append('folder', folder || IMAGEKIT_FOLDER);
    form.append('useUniqueFileName', 'true');
    if (tags) form.append('tags', tags);
    const resp = await fetch(IMAGEKIT_UPLOAD_URL, {
      method: 'POST',
      headers: { Authorization: authHeader() },
      body: form,
      signal: controller.signal
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || !data.url) {
      const message = (data && data.message) || 'Upload ke ImageKit gagal';
      const err = new Error(message);
      err.code = 'IMAGEKIT_UPLOAD_FAILED';
      throw err;
    }
    return { imageUrl: data.url, fileId: data.fileId || '', filePath: data.filePath || '' };
  } finally {
    clearTimeout(timer);
  }
}

// Versi "sekali coba" -- gak ada retry internal, dipakai di migrasi batch
// (lib/imageMigration.js) yang punya budget waktu ketat per item & pengulangan
// sendiri di level batch (item gagal tetap "pending" dan otomatis dicoba lagi
// di batch berikutnya, jadi gak butuh retry berlapis di sini). Terima Buffer
// mentah langsung -- TIDAK lewat base64, karena sumbernya juga di-download
// sebagai Buffer (lihat fetchImageAsBuffer di bawah), jadi gak ada alasan
// nge-roundtrip ke base64 di tengah-tengah.
async function uploadBufferToImageKitOnce(buffer, { fileName, folder, tags, timeoutMs = 8000, mime, ext = 'jpg' } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    const err = new Error('Data gambar kosong/tidak valid');
    err.code = 'INVALID_IMAGE';
    throw err;
  }
  const name = fileName || randomFileName(ext);
  return doUpload(buffer, { fileName: name, folder, tags, timeoutMs, mime });
}

// Versi dengan retry -- dipakai buat upload foto langsung dari user (tambah
// barang/edit foto), sama seperti pola uploadToImgBB().
async function uploadToImageKit(base64DataUrl, requestStartedAt = Date.now(), opts = {}) {
  const base64Only = String(base64DataUrl || '').replace(/^data:image\/\w+;base64,/, '');
  if (!base64Only) {
    const err = new Error('Data gambar kosong/tidak valid');
    err.code = 'INVALID_IMAGE';
    throw err;
  }
  const fileName = opts.fileName || randomFileName(extFromDataUrl(base64DataUrl));

  try {
    return await doUpload(base64Only, { fileName, folder: opts.folder, tags: opts.tags, timeoutMs: FIRST_ATTEMPT_TIMEOUT_MS });
  } catch (firstErr) {
    if (firstErr.code === 'IMAGEKIT_NOT_CONFIGURED') throw firstErr;
    const remainingBudget = (requestStartedAt + FUNCTION_DEADLINE_MS) - Date.now() - SAFETY_MARGIN_MS;
    if (remainingBudget < 3000) {
      alertImageKitFailure(firstErr.name === 'AbortError' ? 'Timeout, sisa waktu gak cukup buat retry' : firstErr.message);
      const err = new Error(firstErr.name === 'AbortError'
        ? 'ImageKit tidak merespons dalam waktu yang wajar. Coba lagi.'
        : 'Gagal menghubungi ImageKit. Coba lagi.');
      err.code = firstErr.name === 'AbortError' ? 'IMAGEKIT_TIMEOUT' : 'IMAGEKIT_UPLOAD_FAILED';
      throw err;
    }
    try {
      return await doUpload(base64Only, { fileName, folder: opts.folder, tags: opts.tags, timeoutMs: remainingBudget });
    } catch (secondErr) {
      alertImageKitFailure(`Gagal 2x berturut-turut: ${secondErr.message}`);
      const err = new Error(secondErr.name === 'AbortError'
        ? 'ImageKit tidak merespons dalam waktu yang wajar. Coba lagi.'
        : 'Gagal menghubungi ImageKit. Coba lagi.');
      err.code = secondErr.name === 'AbortError' ? 'IMAGEKIT_TIMEOUT' : 'IMAGEKIT_UPLOAD_FAILED';
      throw err;
    }
  }
}

// ImgBB punya proteksi hotlink/bot -- request server-side yang gak kirim
// header kayak browser beneran (User-Agent, Referer) bakal ditolak/dibatalin
// diam-diam. Ini bukan hipotesis: ini penyebab pasti migrasi kemarin macet
// di tengah jalan (2 kandidat paling depan gagal download terus-terusan,
// gak pernah gantian ke foto berikutnya karena query candidate selalu narik
// dokumen yang sama selama belum ada yang berhasil).
const IMGBB_DOWNLOAD_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer': 'https://ibb.co/'
};

const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

// Ambil bytes gambar dari URL eksternal (dipakai migrasi: download dulu dari
// ImgBB, baru upload ulang ke ImageKit) -- dibalikin sebagai Buffer MENTAH,
// bukan base64. Foto cuma "lewat" doang di server (download -> upload),
// gak pernah ditampilin/diedit sebagai teks, jadi gak ada untungnya
// dikonversi ke base64 di tengah jalan -- cuma nambah ~33% ukuran data &
// kerjaan CPU buat encode/decode yang percuma. Dibatasin ukuran & waktu
// biar gak nyangkut kalau sumbernya lambat/gede, dan biar 1 gambar rusak
// gak nge-hang seluruh batch migrasi.
async function fetchImageAsBuffer(url, { timeoutMs = 6000, maxBytes = 6 * 1024 * 1024 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal, headers: IMGBB_DOWNLOAD_HEADERS });
    if (!resp.ok) {
      const err = new Error(`Gagal ambil gambar sumber (HTTP ${resp.status})`);
      err.code = 'SOURCE_FETCH_FAILED';
      throw err;
    }
    const contentType = resp.headers.get('content-type') || '';
    if (!/^image\//.test(contentType)) {
      const err = new Error(`Sumber bukan gambar (content-type: ${contentType || 'tidak diketahui'})`);
      err.code = 'SOURCE_NOT_IMAGE';
      throw err;
    }
    const contentLength = Number(resp.headers.get('content-length') || 0);
    if (contentLength && contentLength > maxBytes) {
      const err = new Error('Ukuran gambar sumber terlalu besar');
      err.code = 'SOURCE_TOO_LARGE';
      throw err;
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length > maxBytes) {
      const err = new Error('Ukuran gambar sumber terlalu besar');
      err.code = 'SOURCE_TOO_LARGE';
      throw err;
    }
    const mime = contentType.split(';')[0].trim();
    return { buffer, mime, ext: MIME_EXT[mime] || 'jpg' };
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error('Timeout ambil gambar sumber');
      e.code = 'SOURCE_TIMEOUT';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { uploadToImageKit, uploadBufferToImageKitOnce, fetchImageAsBuffer, IMAGEKIT_FOLDER };
