const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  userAgent: { type: String, trim: true, default: '' },
  // installation ID random (crypto.randomUUID(), dibuat sekali di frontend
  // & disimpan di localStorage) -- dipakai buat dedup sesi per DEVICE FISIK
  // yang sebenarnya. Optional: client lama yang belum update belum ngirim
  // ini, jadi dedup fallback ke deviceLabel (lihat lib/auth.js signToken).
  deviceId: { type: String, trim: true, default: '' },
  // Nama device "asli" (mis. "Poco X6 5G"), dikirim manual dari client lewat
  // Client Hints API (navigator.userAgentData.getHighEntropyValues) karena
  // User-Agent header standar dari browser modern udah gak berisi model HP
  // (di-generic-in demi privasi sejak Chrome ~110+, cth: "Android 10; K").
  // Optional -- browser yang gak support Client Hints (Firefox, Safari, dll)
  // gak bakal ngirim ini, jadi tetap fallback ke parsing `userAgent` biasa.
  deviceLabel: { type: String, trim: true, default: '' }
}, { _id: false });

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true, lowercase: true },
  passwordHash: { type: String, required: true },
  name: { type: String, required: true, trim: true },
  role: { type: String, enum: ['admin', 'kasir'], default: 'kasir' },
  tokenVersion: { type: Number, default: 0 }, // sudah tidak dipakai untuk auth, disimpan untuk kompatibilitas data lama
  activeSessions: { type: [sessionSchema], default: [] }
}, { timestamps: true });

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
