const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');

// Fail-closed: server WAJIB gagal start kalau JWT_SECRET belum di-set,
// tanpa kecuali -- gak ada fallback dev/test tersimpan di source code.
if (!process.env.JWT_SECRET) {
  throw new Error(
    'JWT_SECRET wajib diset di environment variable sebelum server dijalankan.'
  );
}
const JWT_SECRET = process.env.JWT_SECRET;

// Setiap login membuat sessionId baru yang unik dan dicatat di user.activeSessions.
// Logout cuma menghapus sessionId itu dari daftar -- device/sesi lain tidak ikut ke-revoke.
async function signToken(user, userAgent = '', deviceLabel = '', deviceId = '') {
  const sessionId = crypto.randomBytes(16).toString('hex');
  const cleanUserAgent = String(userAgent || '').slice(0, 200);
  const cleanDeviceLabel = String(deviceLabel || '').slice(0, 80);
  const cleanDeviceId = String(deviceId || '').slice(0, 100);

  // Dulu SETIAP login selalu $push sesi baru doang, gak pernah mbuang sesi
  // LAMA dari device yang sama -- kalau satu device login-logout/clear-data
  // berkali-kali (kejadian beneran waktu testing), activeSessions numpuk
  // banyak entri "device" yang identik (beda sessionId doang, device fisiknya
  // sama), bikin daftar "Lihat device" di panel admin isinya duplikat semua.
  //
  // Fix: sebelum push sesi baru, buang dulu sesi LAMA yang device-nya
  // sama persis -- device login lagi = sesi lamanya "digantiin", bukan
  // numpuk.
  //
  // Prioritas dedup: deviceId (installation ID random, generate sekali di
  // frontend & disimpan localStorage) kalau client ngirim itu -- ini ID
  // per-device-fisik yang beneran unik, gak mungkin collision. Kalau client
  // gak ngirim deviceId (versi lama / localStorage baru di-clear), fallback
  // ke deviceLabel (model HP dari Client Hints) SEPERTI SEBELUMNYA -- walau
  // itu cuma nama model, bukan ID unik per fisik device (dua HP model sama
  // bisa keliatan "sama" dan saling nge-pull sesi satu sama lain). Kalau
  // dua-duanya kosong (browser gak support Client Hints & gak ada deviceId),
  // ya gak di-dedup sama sekali -- lebih aman numpuk dikit daripada salah
  // nendang punya orang lain.
  const dedupFilter = cleanDeviceId
    ? { deviceId: cleanDeviceId }
    : (cleanDeviceLabel ? { deviceLabel: cleanDeviceLabel, deviceId: '' } : null);
  if (dedupFilter) {
    await User.updateOne(
      { _id: user._id },
      { $pull: { activeSessions: dedupFilter } }
    );
  }

  await User.updateOne(
    { _id: user._id },
    { $push: { activeSessions: {
        sessionId,
        userAgent: cleanUserAgent,
        deviceLabel: cleanDeviceLabel,
        deviceId: cleanDeviceId
      } } }
  );
  const token = jwt.sign(
    { id: String(user._id), username: user.username, role: user.role, sid: sessionId },
    JWT_SECRET,
    { expiresIn: '400d' }
  );
  return token;
}

// Rolling refresh: token punya lifetime 400 hari, tapi user yang masih
// aktif gak perlu login ulang -- daripada nunggu sampai mepet expired
// (sisa <=30 hari), refresh dipicu berdasarkan UMUR token: begitu token
// udah dipakai lebih dari 7 hari sejak diterbitkan (login/refresh
// terakhir), terbitkan token baru (400 hari lagi) dan kirim lewat header
// X-Auth-Refresh. Efeknya: user yang buka app tiap 1-2 minggu pun tetap
// ke-refresh terus, exp-nya gak pernah kepepet -- bukan cuma yang bukanya
// tiap hari. sessionId TETAP sama (bukan sesi baru), jadi ini bukan celah
// buat nge-bypass revoke: begitu admin nge-revoke sessionId itu di
// activeSessions, baik token lama maupun token hasil refresh sama-sama
// langsung invalid.
//
// Kenapa umur token (iat), bukan tiap request: refresh cuma nge-sign ulang
// JWT (gak nyentuh DB sama sekali, murah), tapi tetap gak ada gunanya
// nge-refresh token yang baru aja diterbitin beberapa menit lalu -- 7 hari
// adalah jarak wajar antar refresh selama user masih dianggap aktif.
const REFRESH_IF_OLDER_THAN_SECONDS = 7 * 24 * 60 * 60;

function maybeIssueRefreshedToken(payload, res) {
  if (!payload.iat) return;
  const now = Math.floor(Date.now() / 1000);
  const tokenAge = now - payload.iat;
  if (tokenAge < REFRESH_IF_OLDER_THAN_SECONDS) return;

  const newToken = jwt.sign(
    { id: String(payload.id), username: payload.username, role: payload.role, sid: payload.sid },
    JWT_SECRET,
    { expiresIn: '400d' }
  );
  res.setHeader('X-Auth-Refresh', newToken);
  res.setHeader('Access-Control-Expose-Headers', 'X-Auth-Refresh');
}

function publicUser(user) {
  return { id: user._id, username: user.username, name: user.name, role: user.role };
}

async function requireAuth(req, res, next) {
  try {
    const header = req.header('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Belum login', code: 'NO_TOKEN' });

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      return res.status(401).json({ error: 'Sesi tidak valid, silakan login ulang', code: 'INVALID_TOKEN' });
    }

    const user = await User.findById(payload.id).lean();
    if (!user) return res.status(401).json({ error: 'Akun tidak ditemukan', code: 'INVALID_TOKEN' });

    const sessionStillActive = (user.activeSessions || []).some(s => s.sessionId === payload.sid);
    if (!sessionStillActive) {
      return res.status(401).json({ error: 'Sesi sudah tidak berlaku, silakan login ulang', code: 'INVALID_TOKEN' });
    }

    maybeIssueRefreshedToken(payload, res);

    req.user = { id: String(user._id), username: user.username, name: user.name, role: user.role };
    req.sessionId = payload.sid;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Khusus admin' });
  }
  next();
}

module.exports = { signToken, publicUser, requireAuth, requireAdmin, JWT_SECRET };
