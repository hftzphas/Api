const mongoose = require('mongoose');

// Notification inbox -- log yang bisa dibuka ulang di dalam app (lonceng
// di header), pendamping push notification yang cuma popup sekali lewat.
// SATU inbox buat semua orang yang pakai toko (bukan per-user) -- toko
// kecil, gak perlu kerumitan notifikasi per akun; siapa aja yang buka app
// liat log yang sama, dan "dibaca" berlaku global (ketandain buat semua
// begitu salah satu orang buka).
// SATU inbox buat semua orang, tapi field ini bikin sebagian notif bisa
// disaring supaya CUMA keliatan buat admin (contoh: notifikasi ada yang
// login). Non-admin (kasir) gak butuh tau kapan akun lain login -- itu
// informasi keamanan yang relevannya buat pemilik toko doang. Default false
// supaya semua jenis notif LAMA (stok, expired, dll) tetap perilaku sama
// kayak sebelumnya (keliatan buat semua orang) tanpa perlu migrasi data.
const notificationSchema = new mongoose.Schema({
  type: { type: String, required: true, trim: true }, // 'stok_habis' | 'stok_menipis' | 'barang_expired' | 'pengumuman' | 'login'
  title: { type: String, required: true, trim: true },
  message: { type: String, required: true, trim: true },
  read: { type: Boolean, default: false },
  adminOnly: { type: Boolean, default: false },
  // ID transaksi terkait (kalau notifnya soal transaksi/piutang) -- dipakai
  // frontend buat lompat ke detail transaksi itu pas notifnya di-klik. Null
  // buat notif yang emang gak nempel ke 1 transaksi spesifik (stok, pengumuman).
  refId: { type: mongoose.Schema.Types.ObjectId, default: null }
}, { timestamps: true });

notificationSchema.index({ createdAt: -1 });
notificationSchema.index({ read: 1 });
// TTL index -- MongoDB otomatis hapus notifikasi 7 hari setelah dibuat
// (berdasarkan umur, bukan status baca/belum). Proses hapusnya bawaan
// MongoDB sendiri (jalan background tiap ~60 detik), jadi GAK butuh cron
// job atau endpoint tambahan apa pun.
notificationSchema.index({ createdAt: 1 }, { expires: 604800 }); // 604800 detik = 7 hari

module.exports = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);
