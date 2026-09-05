const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { signToken, publicUser, requireAuth, requireAdmin } = require('../lib/authLib');
const { authLimiter } = require('../lib/rateLimit');
const { validate } = require('../lib/validate');
const { registerSchema, loginSchema } = require('../lib/schemas');
const { sendTelegramNotif, escapeHtmlForTelegram: esc } = require('../lib/telegram');
const Notification = require('../models/Notification');

router.get('/status', async (req, res) => {
  try {
    const count = await User.countDocuments();
    res.json({ hasUsers: count > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/register', authLimiter, requireAuth, requireAdmin, validate(registerSchema), async (req, res) => {
  try {
    const { username, password, name, role } = req.body;
    if (!username || !password || !name) {
      return res.status(400).json({ error: 'Username, password, dan nama wajib diisi' });
    }

    const existing = await User.findOne({ username: username.toLowerCase() });
    if (existing) return res.status(400).json({ error: 'Username sudah dipakai' });
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({
      username: username.toLowerCase(),
      passwordHash,
      name,
      role: role === 'admin' ? 'admin' : 'kasir'
    });
    res.status(201).json(publicUser(user));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/login', authLimiter, validate(loginSchema), async (req, res) => {
  try {
    const { username, password, deviceLabel, deviceId } = req.body;
    const user = await User.findOne({ username: (username || '').toLowerCase() });
    if (!user) return res.status(401).json({ error: 'Username atau password salah' });
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(401).json({ error: 'Username atau password salah' });
    const token = await signToken(user, req.header('user-agent'), deviceLabel, deviceId);

    // Notif login -- CUMA buat kepentingan keamanan si pemilik toko (mau tau
    // kalau ada yang login ke akun mana pun, termasuk akun sendiri dari HP
    // baru), makanya dikirim ke Telegram (japri ke pemilik) DAN dicatet di
    // inbox notif dalam app tapi ditandain adminOnly -- kasir lain gak perlu
    // (dan gak semestinya) tau kapan rekan kerjanya login. deviceLabel itu
    // teks bebas dari client (request body), WAJIB di-escape sebelum ditempel
    // ke pesan Telegram (lihat komentar panjang di lib/telegram.js kenapa).
    const label = String(deviceLabel || '').trim();
    const waktuWib = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' });
    const deviceInfo = label ? ` dari perangkat "${esc(label)}"` : '';
    // BUG FIX: username sebelumnya ditulis dengan prefix "@" (mis. "@hafitz")
    // -- di Telegram ini otomatis ke-render jadi mention/link beneran (biru,
    // bisa ditap), padahal bukan itu maksudnya (cuma mau nunjukin username).
    // Dihapus prefix-nya di kedua tempat (Telegram & notif in-app) biar
    // konsisten cuma nampilin "hafitz" polos.
    await sendTelegramNotif(
      `🔐 <b>Login baru</b>\n${esc(user.name)} (${esc(user.username)}, ${user.role})${deviceInfo}\n${waktuWib} WIB`
    );
    await Notification.create({
      type: 'login',
      title: 'Login baru',
      message: `${user.name} (${user.username}, ${user.role}) login${label ? ` dari "${label}"` : ''} pada ${waktuWib} WIB`,
      adminOnly: true
    });

    res.json({ token, user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  res.json(req.user);
});

router.get('/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    // Balik ke balikin SEMUA role (admin + kasir) -- sempet difilter jadi
    // cuma role:'kasir' doang, tapi ternyata akun admin sendiri jadi gak
    // ikut kekirim, padahal device-list & tombol "paksa logout" (lihat
    // js/modules/auth.js -- loadUsers()) masih kepake buat akun admin juga,
    // bukan cuma buat kasir. Yang emang gak perlu cuma tombol HAPUS-nya
    // doang buat akun admin, dan itu udah disaring di frontend (bukan di
    // sini), jadi endpoint ini tetap balikin data lengkap apa adanya.
    const users = await User.find().select('-passwordHash -activeSessions').sort({ createdAt: 1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (String(req.params.id) === String(req.user.id)) {
      return res.status(400).json({ error: 'Tidak bisa menghapus akun sendiri' });
    }
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Akun tidak ditemukan' });
    if (target.role === 'admin') {
      const adminCount = await User.countDocuments({ role: 'admin' });
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Tidak bisa menghapus admin terakhir' });
      }
    }
    await User.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/users/:id/revoke', requireAuth, requireAdmin, async (req, res) => {
  try {
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Akun tidak ditemukan' });
    target.activeSessions = [];
    await target.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Daftar device/sesi yang lagi aktif buat 1 akun (dipakai admin buat liat
// "lagi login di HP/browser mana aja"). sessionId ditampilkan penuh karena
// admin butuh itu buat nge-kick sesi tertentu lewat endpoint di bawah --
// bukan rahasia yang bisa disalahgunakan sendirian (tetap butuh JWT si user
// yang bersangkutan buat jadi sesi valid).
router.get('/users/:id/sessions', requireAuth, requireAdmin, async (req, res) => {
  try {
    const target = await User.findById(req.params.id).select('activeSessions');
    if (!target) return res.status(404).json({ error: 'Akun tidak ditemukan' });
    const sessions = [...target.activeSessions]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map(s => ({
        sessionId: s.sessionId,
        createdAt: s.createdAt,
        userAgent: s.userAgent,
        deviceLabel: s.deviceLabel,
        isCurrent: s.sessionId === req.sessionId
      }));
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Kick 1 device/sesi doang (beda dari /revoke yang nge-logout SEMUA sesi
// akun itu sekaligus). Dipakai pas admin cuma mau matiin 1 HP yang hilang
// misalnya, tanpa ganggu device lain yang masih dipake orangnya.
router.delete('/users/:id/sessions/:sessionId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Akun tidak ditemukan' });
    const before = target.activeSessions.length;
    target.activeSessions = target.activeSessions.filter(s => s.sessionId !== req.params.sessionId);
    if (target.activeSessions.length === before) {
      return res.status(404).json({ error: 'Sesi tidak ditemukan (mungkin sudah logout duluan)' });
    }
    await target.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/logout', requireAuth, async (req, res) => {
  try {
    // Cuma hapus sesi yang sedang dipakai token ini -- device/sesi lain milik
    // user yang sama tetap login (beda dengan /revoke yang paksa logout semua).
    await User.updateOne(
      { _id: req.user.id },
      { $pull: { activeSessions: { sessionId: req.sessionId } } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
