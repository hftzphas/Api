const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../lib/authLib');
const { broadcastLimiter } = require('../lib/rateLimit');
const { logActivity } = require('../lib/activityLogLib');
const { sendTelegramNotif, escapeHtmlForTelegram: esc } = require('../lib/telegram');
const { notifyEvent } = require('../lib/notify');

const MAX_MESSAGE_LENGTH = 2000;

// Endpoint ini sengaja SATU ARAH doang (server -> Telegram), gak ada
// komponen nerima balesan dari Telegram sama sekali -- beda dari fitur
// bot 2-arah yang sempat dibuat lalu di-revert. Karena gak nerima input
// dari Telegram, endpoint ini gak butuh webhook, secret token, atau
// whitelist chat_id -- otentikasinya CUKUP requireAuth+requireAdmin biasa
// (sama kayak endpoint lain di web), soalnya yang manggil endpoint ini
// selalu dari dashboard kita sendiri, bukan dari Telegram.
router.post('/broadcast', requireAuth, requireAdmin, broadcastLimiter, async (req, res) => {
  try {
    const message = String(req.body.message || '').trim();
    if (!message) {
      return res.status(400).json({ error: 'Pesan tidak boleh kosong' });
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: `Pesan maksimal ${MAX_MESSAGE_LENGTH} karakter` });
    }

    // sendTelegramNotif pakai parse_mode HTML -- escape dulu biar karakter
    // <, >, & dari input admin (misal nulis "harga < 5rb") gak diartiin
    // sebagai tag HTML sama Telegram (bisa bikin format pesan berantakan
    // atau pesan gagal terkirim kalau taknya gak valid/gak ke-close).
    const escaped = esc(message);

    await sendTelegramNotif(`📢 <b>Pengumuman dari ${esc(req.user.name)}</b>\n\n${escaped}`);
    notifyEvent({
      type: 'pengumuman',
      title: `Pengumuman dari ${req.user.name}`,
      message
    }).catch(() => {});

    await logActivity(req, 'broadcast_telegram', '', message.slice(0, 200));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
