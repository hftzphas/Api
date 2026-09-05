// Node.js 18+ udah nyediain fetch() global bawaan (undici), jadi node-fetch
// gak perlu lagi dipasang sebagai dependency terpisah.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// Semua sendTelegramNotif() di seluruh codebase ini dipanggil dengan
// parse_mode: 'HTML' (lihat di bawah), jadi SETIAP potongan teks yang
// asalnya dari input user -- nama produk/varian (bisa diisi kasir manapun,
// bukan cuma admin, lihat routes/products.js), alasan void/retur, nama
// pelanggan, dst -- WAJIB lewat fungsi ini dulu sebelum ditempel ke
// template string pesan Telegram. Kalau kelewat, ada 2 dampak nyata:
//   1) Kasir iseng/khilaf ketik tag gak seimbang (mis. cuma "<" doang) di
//      alasan void -> seluruh request sendMessage ke Telegram DITOLAK API-
//      nya (400) -> notifikasi gagal terkirim TANPA ada yang notice, karena
//      sendTelegramNotif() sengaja fire-and-forget & errornya cuma
//      di-console.error (lihat komentar di sendTelegramNotif).
//   2) Yang lebih serius: Telegram HTML parse_mode TETAP mengizinkan tag
//      `<a href="...">teks</a>` -- jadi nama produk/alasan yang isinya link
//      ke situs phishing bakal kekirim sebagai LINK BENERAN yang keklik di
//      Telegram pemilik toko, seolah-olah pesan resmi dari bot yang mereka
//      percaya. Ini vektor social-engineering, bukan cuma masalah format.
function escapeHtmlForTelegram(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Function di Vercel dibatasin 30 detik total (lihat vercel.json).
const FUNCTION_DEADLINE_MS = 30000;
// Margin buat proses lain (baca DB, generate zip) yang udah kepake waktu
// sebelum sampai kirim ke Telegram, plus buffer response balik ke client.
const SAFETY_MARGIN_MS = 3000;

async function fetchWithTimeout(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Kirim ke Telegram kadang sesekali gagal doang (network blip / cold start
// serverless yang bikin request pertama lambat), terus normal lagi pas
// dicoba ulang. Daripada langsung nyerah dan bikin user harus klik tombol
// lagi manual, di sini kita kasih timeout wajar + 1x auto-retry dulu --
// TAPI cuma kalau sisa waktu function masih cukup. Kalau dipaksain retry
// pas waktu udah mepet, Vercel bakal motong function di tengah jalan
// (bukan lewat catch/reject kita, tapi kill paksa) dan user gak dapet
// pesan error sama sekali -- cuma stuck loading lalu gagal diam-diam.
// Lebih baik kita yang nyerah duluan dengan pesan jelas.
//
// requestStartedAt WAJIB dikirim dari titik paling awal tiap request HTTP
// (bukan dihitung sekali pas module di-load), soalnya di serverless yang lagi
// "warm" (gak cold start), module yang sama bisa dipakai ulang buat banyak
// request berbeda -- kalau patokan waktunya global, sisa budget bakal ngaco.
async function fetchWithRetry(url, options, timeoutMs = 15000, requestStartedAt = Date.now()) {
  try {
    return await fetchWithTimeout(url, options, timeoutMs);
  } catch (err) {
    const remainingBudget = (requestStartedAt + FUNCTION_DEADLINE_MS) - Date.now() - SAFETY_MARGIN_MS;
    if (remainingBudget < timeoutMs) {
      throw err;
    }
    return await fetchWithTimeout(url, options, Math.min(timeoutMs, remainingBudget));
  }
}

async function sendTelegramNotif(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('Telegram not configured');
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML'
      })
    });
    if (!response.ok) {
      console.error('Telegram send failed:', response.statusText);
    }
  } catch (err) {
    console.error('Telegram error:', err.message);
  }
}

async function sendTelegramDocument(filename, content, caption, contentType = 'text/csv', requestStartedAt = Date.now()) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('Telegram not configured');
    return false;
  }
  try {
    const boundary = '----KasirHnKBoundary' + Date.now();
    const parts = [];
    const field = (name, value) => {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    };
    field('chat_id', TELEGRAM_CHAT_ID);
    if (caption) field('caption', caption);
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`));
    const isCsv = contentType === 'text/csv';
    // content bisa berupa string (CSV/JSON biasa) atau Buffer langsung (misal
    // file JSON yang udah di-gzip supaya lebih kecil/cepet keupload).
    const contentBuffer = Buffer.isBuffer(content) ? content : Buffer.from((isCsv ? '\uFEFF' : '') + content, 'utf-8');
    parts.push(contentBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    // Sekarang cuma ngirim 1 file (zip gabungan), bukan beberapa file besar
    // paralel kayak dulu -- jadi amanlah dikasih retry biasa buat semua
    // ukuran. Timeout absolut (bukan cuma per-percobaan) dihitung dari
    // requestStartedAt supaya gak kena kill paksa sama Vercel di tengah retry.
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`;
    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body
    }, 12000, requestStartedAt);
    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText);
      console.error('Telegram document send failed:', errText);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Telegram document error:', err.message);
    return false;
  }
}

module.exports = { sendTelegramNotif, sendTelegramDocument, escapeHtmlForTelegram };
