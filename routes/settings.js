const express = require('express');
const router = express.Router();
const Setting = require('../models/Setting');
const { requireAuth, requireAdmin } = require('../lib/authLib');

const ALLOWED_KEYS = ['qris_image', 'receipt_footer', 'low_stock_threshold', 'expiry_warning_days', 'custom_payment_methods', 'notif_struk', 'notif_stok_habis', 'notif_stok_menipis', 'notif_barang_expired', 'notif_transaksi', 'notif_piutang', 'diskon_enabled'];

function validateSettingValue(key, value) {
  if (typeof value !== 'string') return 'Value wajib berupa string';
  if (key === 'qris_image') {
    if (value.length > 1_500_000) return 'Ukuran gambar terlalu besar (maks ~1MB)';
    if (value && !/^data:image\/(png|jpe?g|webp);base64,/.test(value)) return 'Format gambar tidak valid';
    return null;
  }
  if (key === 'receipt_footer') {
    if (value.length > 500) return 'Pesan footer struk maksimal 500 karakter';
    return null;
  }
  if (key === 'low_stock_threshold') {
    if (value === '') return null; // kosong = pakai default bawaan
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return 'Batas stok menipis harus bilangan bulat positif';
    return null;
  }
  if (key === 'expiry_warning_days') {
    if (value === '') return null; // kosong = pakai default bawaan
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return 'Batas hari mendekati expired harus bilangan bulat positif';
    return null;
  }
  if (key === 'custom_payment_methods') {
    if (value === '') return null; // kosong = gak ada metode custom
    let parsed;
    try { parsed = JSON.parse(value); } catch (e) { return 'Format tidak valid'; }
    if (!Array.isArray(parsed)) return 'Format harus berupa daftar (array)';
    if (parsed.length > 10) return 'Maksimal 10 metode pembayaran custom';
    for (const name of parsed) {
      if (typeof name !== 'string' || !name.trim() || name.length > 40) {
        return 'Setiap nama metode wajib diisi & maksimal 40 karakter';
      }
    }
    return null;
  }
  if (key === 'notif_struk' || key === 'notif_stok_habis' || key === 'notif_stok_menipis' || key === 'notif_barang_expired' || key === 'notif_transaksi' || key === 'notif_piutang' || key === 'diskon_enabled') {
    if (!['on', 'off'].includes(value)) return 'Value harus "on" atau "off"';
    return null;
  }
  return null;
}

// GET sengaja dibiarin publik buat key tertentu doang -- ini yang dipakai
// buat nampilin gambar QRIS ke pelanggan pas checkout, jadi harus bisa
// diakses tanpa login. Key SELAIN itu (custom_payment_methods, threshold,
// dll) tetap wajib login: sebelumnya SEMUA ALLOWED_KEYS ikut kebaca publik,
// padahal cuma qris_image yang memang butuh itu.
const PUBLIC_KEYS = new Set(['qris_image']);

router.get('/:key', async (req, res) => {
  try {
    if (!ALLOWED_KEYS.includes(req.params.key)) {
      return res.status(400).json({ error: 'Key tidak dikenal' });
    }
    if (!PUBLIC_KEYS.has(req.params.key)) {
      return requireAuth(req, res, async () => {
        const setting = await Setting.findOne({ key: req.params.key });
        res.json({ key: req.params.key, value: setting ? setting.value : '' });
      });
    }
    const setting = await Setting.findOne({ key: req.params.key });
    res.json({ key: req.params.key, value: setting ? setting.value : '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:key', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!ALLOWED_KEYS.includes(req.params.key)) {
      return res.status(400).json({ error: 'Key tidak dikenal' });
    }
    const { value } = req.body;
    const validationError = validateSettingValue(req.params.key, value);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }
    const setting = await Setting.findOneAndUpdate(
      { key: req.params.key },
      { value },
      { new: true, upsert: true, runValidators: true }
    );
    res.json({ key: setting.key, value: setting.value });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:key', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!ALLOWED_KEYS.includes(req.params.key)) {
      return res.status(400).json({ error: 'Key tidak dikenal' });
    }
    await Setting.findOneAndDelete({ key: req.params.key });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
