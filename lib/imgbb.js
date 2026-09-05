
// Node.js 18+ udah nyediain fetch() global bawaan (undici), jadi node-fetch
// gak perlu lagi dipasang sebagai dependency terpisah.
const { sendTelegramNotif } = require('./telegram');

const IMGBB_API_KEY = process.env.IMGBB_API_KEY || '';
const IMGBB_UPLOAD_URL = 'https://api.imgbb.com/1/upload';

// Function di Vercel dibatasin 30 detik total (lihat vercel.json). Percobaan
// pertama dikasih jatah 20 detik -- kalau itu gagal/timeout, SISA budget
// (bukan 30 detik penuh lagi) dipakai buat 1x retry, jadi total dua-duanya
// gak pernah lewatin batas function dan bikin Vercel kill paksa di tengah
// jalan (yang efeknya lebih parah: user gak dapet pesan error sama sekali).
const FUNCTION_DEADLINE_MS = 30000;
const FIRST_ATTEMPT_TIMEOUT_MS = 20000;
const SAFETY_MARGIN_MS = 3000;

// Alert "ImgBB gagal" cuma dikirim kalau alert terakhir udah lebih dari 15
// menit lalu -- biar sekali ImgBB ngambek gak nge-spam banyak notif Telegram
// beruntun tiap ada user yang nambah foto barang. Ini state per-instance
// (in-memory), bukan disimpan di DB, jadi kalau function-nya cold start baru
// (instance baru), rate-limit ini reset dan alert pertama tetap kekirim --
// itu udah cukup untuk tujuannya (mencegah spam), gak perlu presisi.
const ALERT_COOLDOWN_MS = 15 * 60 * 1000;
let lastAlertAt = 0;
function alertImgBBFailure(reason) {
  const now = Date.now();
  if (now - lastAlertAt < ALERT_COOLDOWN_MS) return;
  lastAlertAt = now;
  sendTelegramNotif(`🚨 <b>Upload foto ke ImgBB gagal</b>\n${reason}\n\nKalau ini terus berulang, cek IMGBB_API_KEY (mungkin expired/kena limit).`);
}

async function attemptUpload(base64Only, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = new URLSearchParams();
    body.append('key', IMGBB_API_KEY);
    body.append('image', base64Only);
    return await fetch(`${IMGBB_UPLOAD_URL}?expiration=0`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function uploadToImgBB(base64DataUrl, requestStartedAt = Date.now()) {
  if (!IMGBB_API_KEY) {
    const err = new Error('IMGBB_API_KEY belum di-set di environment server');
    err.code = 'IMGBB_NOT_CONFIGURED';
    throw err;
  }
  const base64Only = String(base64DataUrl || '').replace(/^data:image\/\w+;base64,/, '');
  if (!base64Only) {
    const err = new Error('Data gambar kosong/tidak valid');
    err.code = 'INVALID_IMAGE';
    throw err;
  }

  let resp;
  try {
    resp = await attemptUpload(base64Only, FIRST_ATTEMPT_TIMEOUT_MS);
  } catch (firstErr) {
    // Cuma retry kalau sisa waktu function masih cukup buat percobaan kedua
    // (minimal beberapa detik) -- kalau udah mepet, mending nyerah dengan
    // pesan jelas daripada dipaksain retry terus di-kill paksa sama Vercel.
    const remainingBudget = (requestStartedAt + FUNCTION_DEADLINE_MS) - Date.now() - SAFETY_MARGIN_MS;
    if (remainingBudget < 3000) {
      alertImgBBFailure(firstErr.name === 'AbortError' ? 'Timeout, sisa waktu gak cukup buat retry' : firstErr.message);
      const err = new Error(firstErr.name === 'AbortError'
        ? 'ImgBB tidak merespons dalam waktu yang wajar. Coba lagi.'
        : 'Gagal menghubungi ImgBB. Coba lagi.');
      err.code = firstErr.name === 'AbortError' ? 'IMGBB_TIMEOUT' : 'IMGBB_UPLOAD_FAILED';
      throw err;
    }
    try {
      resp = await attemptUpload(base64Only, remainingBudget);
    } catch (secondErr) {
      alertImgBBFailure(`Gagal 2x berturut-turut: ${secondErr.message}`);
      const err = new Error(secondErr.name === 'AbortError'
        ? 'ImgBB tidak merespons dalam waktu yang wajar. Coba lagi.'
        : 'Gagal menghubungi ImgBB. Coba lagi.');
      err.code = secondErr.name === 'AbortError' ? 'IMGBB_TIMEOUT' : 'IMGBB_UPLOAD_FAILED';
      throw err;
    }
  }

  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data || !data.success) {
    const message = (data && data.error && data.error.message) || 'Upload ke ImgBB gagal';
    alertImgBBFailure(message);
    const err = new Error(message);
    err.code = 'IMGBB_UPLOAD_FAILED';
    throw err;
  }
  return {
    imageUrl: data.data.display_url || data.data.url,
    deleteUrl: data.data.delete_url || ''
  };
}

module.exports = { uploadToImgBB };
