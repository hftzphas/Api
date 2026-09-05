// Titik pusat buat notifikasi "operasional" yang relevan buat siapapun yang
// pegang toko (bukan cuma pemilik/developer) -- stok habis/menipis, barang
// expired, pengumuman. Dipanggil BERBARENGAN dengan sendTelegramNotif() di
// titik-titik yang sama (lihat routes/transactions.js, lib/expiryCheck.js,
// routes/telegramBroadcast.js), BUKAN gantiin. Alert teknis/infra (MongoDB
// down, upload gagal, dst) sengaja TETAP Telegram-only -- itu buat developer
// debug, bukan buat notifikasi yang dilihat orang rumah.
const webpush = require('web-push');
const Notification = require('../models/Notification');
const PushSubscription = require('../models/PushSubscription');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

let vapidConfigured = false;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  vapidConfigured = true;
}

// Kirim push ke SEMUA device yang pernah subscribe (lihat models/PushSubscription.js).
// Kalau salah satu gagal karena subscription-nya udah gak valid lagi (user
// uninstall app / clear data / dsb -- browser balikin 404/410), langganan
// itu dihapus dari DB di sini juga, biar daftar subscriber gak numpuk sampah
// selama-lamanya. Satu device gagal TIDAK menggagalkan device lain (dikirim
// paralel, per-device coba sendiri-sendiri).
async function sendPushToAll(payload) {
  if (!vapidConfigured) return; // belum di-setup (VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY kosong) -- diam-diam skip, jangan bikin fitur lain ikut error
  const subs = await PushSubscription.find({}).lean();
  if (subs.length === 0) return;
  const body = JSON.stringify(payload);
  await Promise.allSettled(subs.map(async (sub) => {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await PushSubscription.deleteOne({ _id: sub._id }).catch(() => {});
      }
      // Selain itu (mis. timeout jaringan sesaat) dibiarin -- bukan berarti
      // langganannya rusak permanen, gak perlu dihapus cuma gara-gara 1x gagal.
    }
  }));
}

// `type` dipakai frontend buat milih ikon/warna di notification inbox.
// `refId` opsional -- ID transaksi terkait, biar frontend bisa lompat ke
// detail transaksi itu pas notifnya di-klik (lihat models/Notification.js).
async function notifyEvent({ type, title, message, refId = null }) {
  const doc = await Notification.create({ type, title, message, refId });
  // Push dikirim fire-and-forget (gak di-await sampai selesai oleh
  // pemanggil) -- sama filosofinya kayak sendTelegramNotif(), biar lambatnya
  // jaringan push gak bikin request utama (mis. nyimpen transaksi) ikut molor.
  sendPushToAll({ title, body: message, notifId: String(doc._id), type }).catch(() => {});
  return doc;
}

module.exports = { notifyEvent, VAPID_PUBLIC_KEY };
