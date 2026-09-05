const rateLimit = require('express-rate-limit');

// Dipakai di endpoint yang rawan brute force (login, init admin, register akun baru).
// 10 percobaan per 15 menit per IP -- longgar untuk pemakaian normal (salah ketik
// password beberapa kali), tapi bikin brute force jadi tidak praktis.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak percobaan. Coba lagi dalam beberapa menit.' },
  // Reset otomatis kalau percobaan berhasil (biar user yang sering login gak
  // ke-block gara-gara device lain di jaringan yang sama gagal login).
  skipSuccessfulRequests: true
});

// Dipasang global buat SEMUA endpoint (bukan cuma auth). Tujuannya bukan
// nyegah pemakaian normal (kasir mainnya di kisaran puluhan request per
// menit paling rame), tapi ngebatesin kerusakan kalau satu token kasir
// bocor/dicuri -- tanpa limiter ini, token yang bocor bisa dipakai nembak
// request sepuasnya (spam transaksi kosong, drain /reports berkali-kali, dst).
// 300 request/5 menit per IP itu jauh di atas pemakaian wajar toko kecil
// (termasuk pas offline queue nge-sync banyak transaksi sekaligus setelah
// balik online), tapi tetap ngasih rem buat automated abuse.
const apiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak request dari perangkat ini. Coba lagi sebentar lagi.' }
});

// Broadcast Telegram beda dari endpoint biasa -- tiap request BENERAN
// ngirim pesan ke chat admin (bukan cuma baca/tulis DB), jadi limiter-nya
// harus lebih ketat dari apiLimiter umum. 10 broadcast/jam itu jauh lebih
// dari cukup buat pemakaian wajar (pengumuman/pemberitahuan gak mungkin
// dikirim puluhan kali sejam), tapi cukup ngerem kalau ada yang iseng
// nge-spam tombol broadcast berkali-kali -- baik gak sengaja (double klik)
// maupun sengaja. Ini juga jagain reputasi bot dari sisi Telegram sendiri,
// yang bisa nge-throttle/block sementara kalau satu bot ngirim kebanyakan
// pesan dalam waktu singkat.
const broadcastLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak broadcast dikirim. Coba lagi dalam beberapa saat.' }
});

module.exports = { authLimiter, apiLimiter, broadcastLimiter };
