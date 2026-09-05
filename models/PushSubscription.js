const mongoose = require('mongoose');

// 1 dokumen = 1 langganan push per BROWSER/DEVICE (bukan per akun kasir) --
// itu poin utamanya: emak & anak bisa dua-duanya install app di HP
// masing-masing & sama-sama kebagian notif, gak perlu login akun yang sama
// atau share Telegram.
const pushSubscriptionSchema = new mongoose.Schema({
  endpoint: { type: String, required: true, unique: true },
  keys: {
    p256dh: { type: String, required: true },
    auth: { type: String, required: true }
  },
  deviceLabel: { type: String, trim: true, default: '' }
}, { timestamps: true });

module.exports = mongoose.models.PushSubscription || mongoose.model('PushSubscription', pushSubscriptionSchema);
