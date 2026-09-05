const express = require('express');
const router = express.Router();
const Notification = require('../models/Notification');
const PushSubscription = require('../models/PushSubscription');
const { VAPID_PUBLIC_KEY } = require('../lib/notify');

// Publik dalam arti "gak perlu login admin", tapi endpoint ini tetep di
// belakang requireAuth (dipasang pas mounting di api/index.js) -- siapapun
// yang udah login (kasir atau admin) boleh liat/subscribe notifikasi,
// gak dibatasin admin doang, karena notif inbox ini emang buat semua orang
// yang pegang toko (termasuk kasir/keluarga yang bukan admin). Pengecualian:
// notif dengan adminOnly:true (mis. "ada yang login") cuma keliatan buat
// role admin -- lihat filter di GET / dan PUT /mark-read di bawah.

router.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

router.get('/', async (req, res) => {
  try {
    // Notif adminOnly (mis. "ada yang login") disaring keluar buat kasir --
    // req.user.role udah kesedia dari requireAuth yang mounting-nya di
    // api/index.js (lihat komentar atas).
    const filter = req.user.role === 'admin' ? {} : { adminOnly: { $ne: true } };
    const list = await Notification.find(filter).sort({ createdAt: -1 }).limit(50).lean();
    const unreadCount = await Notification.countDocuments({ ...filter, read: false });
    res.json({ list, unreadCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/mark-read', async (req, res) => {
  try {
    // Kasir nge-mark-read TIDAK BOLEH ikut nandain notif adminOnly yang gak
    // pernah dia liat sendiri (gak ke-load di GET / miliknya) -- kalau
    // kebablasan ke-update, admin bisa kelewat notif penting karena statusnya
    // udah "read" duluan sebelum sempat dibuka.
    const filter = req.user.role === 'admin' ? { read: false } : { read: false, adminOnly: { $ne: true } };
    await Notification.updateMany(filter, { read: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/subscribe', async (req, res) => {
  try {
    const { endpoint, keys, deviceLabel } = req.body;
    if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
      return res.status(400).json({ error: 'Data subscription tidak lengkap' });
    }
    // upsert by endpoint -- browser yang sama subscribe ulang (mis. abis
    // clear cache) gak bikin duplikat, cuma nge-update dokumen yang sama.
    await PushSubscription.findOneAndUpdate(
      { endpoint },
      { endpoint, keys, deviceLabel: String(deviceLabel || '').trim() },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (endpoint) {
      await PushSubscription.deleteOne({ endpoint });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
