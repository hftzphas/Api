const mongoose = require('mongoose');
const { sendTelegramNotif } = require('./telegram');

let cached = global._mongooseConn;
if (!cached) {
  cached = global._mongooseConn = { conn: null, promise: null };
}

// Sama kayak alert ImgBB: di-rate-limit 15 menit biar sekali Atlas
// down/unreachable gak nge-spam notif tiap ada request masuk (yang semuanya
// bakal gagal connect selama Atlas belum pulih).
const ALERT_COOLDOWN_MS = 15 * 60 * 1000;
let lastAlertAt = 0;
function alertDbFailure(reason) {
  const now = Date.now();
  if (now - lastAlertAt < ALERT_COOLDOWN_MS) return;
  lastAlertAt = now;
  sendTelegramNotif(`🚨 <b>Koneksi ke MongoDB gagal</b>\n${reason}\n\nCek status Atlas & MONGODB_URI.`);
}

async function connectDB() {
  if (cached.conn) return cached.conn;
  if (!cached.promise) {
    cached.promise = mongoose.connect(process.env.MONGODB_URI, {
      // Biar gagal cepat & jelas kalau Atlas lambat/nggak reachable, daripada
      // diam-diam nge-hang sampai mepet/lewat batas waktu function Vercel
      // (yang tadinya bisa keliatan sebagai "offline" di frontend).
      serverSelectionTimeoutMS: 8000,
      socketTimeoutMS: 20000,
      // Jangan numpuk query nunggu koneksi selesai kalau belum konek - biar
      // errornya langsung ketauan bukan malah menggantung diam-diam.
      bufferCommands: false,
      maxPoolSize: 10
    }).then(m => m);
    // Kalau connect-nya gagal, buang promise yang di-cache biar request
    // berikutnya coba konek dari awal lagi (bukan keburu "ngambek" permanen
    // sampai cold start berikutnya).
    cached.promise.catch(err => {
      cached.promise = null;
      alertDbFailure(err.message);
    });
  }
  cached.conn = await cached.promise;
  return cached.conn;
}

module.exports = connectDB;
