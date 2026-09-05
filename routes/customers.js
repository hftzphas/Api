const express = require('express');
const { requireAdmin } = require('../lib/authLib');
const router = express.Router();
const Customer = require('../models/Customer');
const { validate } = require('../lib/validate');
const { customerSchema } = require('../lib/schemas');

router.get('/', async (req, res) => {
  try {
    const customers = await Customer.find().collation({ locale: 'id', strength: 2 }).sort({ name: 1 }).lean();
    res.json(customers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', validate(customerSchema), async (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!name) return res.status(400).json({ error: 'Nama pelanggan wajib diisi' });
    const cleanName = name.trim();
    const existing = await Customer.findOne({ name: new RegExp(`^${cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
    if (existing) return res.status(200).json(existing);
    try {
      const customer = await Customer.create({ name: cleanName, phone: phone || '' });
      return res.status(201).json(customer);
    } catch (err) {
      // Race: dua request bareng sama-sama lolos pengecekan "belum ada" di
      // atas, terus sama-sama create -- unique index bakal nolak salah
      // satunya (E11000). Daripada dibalikin sebagai error, ambil customer
      // yang barusan berhasil dibuat request lain & balikin itu -- konsisten
      // sama perilaku "return existing" di jalur normal (bukan pesan error
      // dadakan buat kasir yang sebenarnya cuma nyoba nambahin nama yang
      // sama).
      if (err.code === 11000) {
        const raceWinner = await Customer.findOne({ name: new RegExp(`^${cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
        if (raceWinner) return res.status(200).json(raceWinner);
      }
      throw err;
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/payment', async (req, res) => {
  try {
    const { amount, note } = req.body;
    const amt = Number(amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'Jumlah bayar tidak valid' });
    const existing = await Customer.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });
    // Atomic: kondisi balance >= amt dicek & dikurangi dalam satu operasi di DB,
    // bukan baca-ubah-simpan di memory. Ini nyegah lost update kalau ada 2
    // request masuk nyaris bersamaan buat pelanggan yang sama (misal 2 kasir/
    // device beda memproses pembayaran & transaksi bon di waktu yang sama).
    const updated = await Customer.findOneAndUpdate(
      { _id: req.params.id, balance: { $gte: amt } },
      { $inc: { balance: -amt }, $push: { history: { type: 'bayar', amount: amt, note: note || '' } } },
      { new: true }
    );
    if (!updated) {
      return res.status(400).json({ error: `Jumlah bayar melebihi sisa utang (Rp${existing.balance.toLocaleString('id-ID')})` });
    }
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { name, phone } = req.body;
    const customer = await Customer.findByIdAndUpdate(
      req.params.id,
      { name, phone },
      { new: true, runValidators: true }
    );
    if (!customer) return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });
    res.json(customer);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin-only (data pelanggan + riwayat utang dihapus permanen, gak ada jalan
// koreksi) + wajib lunas dulu -- kalau masih ada sisa utang, hapus pelanggan
// bakal ngilangin catatan utang itu tanpa jejak. Kasir yang mau bersihin
// pelanggan lama harus lunasin/nolin saldonya dulu lewat halaman Hutang.
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (!customer) return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });
    if (customer.balance > 0) {
      return res.status(400).json({ error: `Pelanggan ini masih punya sisa utang Rp${customer.balance.toLocaleString('id-ID')} -- lunasi/catat pembayarannya dulu sebelum dihapus.` });
    }
    await Customer.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin-only: bisa nyuntik riwayat utang/bayar mentah (angka & tanggal bebas)
// buat pelanggan baru sekaligus -- bukan hal yang harus bisa dilakuin kasir
// biasa kapan aja.
router.post('/bulk-import', requireAdmin, async (req, res) => {
  try {
    const { customers } = req.body;
    if (!Array.isArray(customers) || customers.length === 0) {
      return res.status(400).json({ error: 'Tidak ada data yang diimpor' });
    }

    const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let created = 0;
    let skipped = 0;
    const errors = [];
    const skips = [];

    for (let i = 0; i < customers.length; i++) {
      const row = customers[i];
      try {
        const name = String(row.name || '').trim();
        if (!name) throw new Error('Nama pelanggan kosong');
        const phone = String(row.phone || '').trim();

        const historyEntries = (Array.isArray(row.history) ? row.history : [])
          .map(h => {
            const type = h.type === 'bayar' ? 'bayar' : 'utang';
            const amount = Number(h.amount) || 0;
            const date = h.date ? new Date(h.date) : new Date();
            return { type, amount, note: String(h.note || ''), date: isNaN(date) ? new Date() : date };
          })
          .filter(h => h.amount > 0);

        let existing = await Customer.findOne({ name: new RegExp(`^${escapeRegex(name)}$`, 'i') });
        if (existing) {
          skipped++;
          skips.push({ row: i + 1, name, reason: 'Pelanggan sudah ada, dilewati' });
          continue;
        }

        const balance = historyEntries.reduce((sum, h) => sum + (h.type === 'utang' ? h.amount : -h.amount), 0);
        await Customer.create({ name, phone, balance, history: historyEntries });
        created++;
      } catch (err) {
        errors.push({ row: i + 1, name: row.name || '', error: err.message });
      }
    }

    res.json({ created, skipped, errors, skips });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/repair-timestamps', requireAdmin, async (req, res) => {
  try {
    const docs = await Customer.collection.find({}).toArray();
    let fixed = 0;
    const fixedNames = [];
    for (const doc of docs) {
      const createdOk = doc.createdAt instanceof Date && !isNaN(doc.createdAt.getTime());
      const updatedOk = doc.updatedAt instanceof Date && !isNaN(doc.updatedAt.getTime());
      if (!createdOk || !updatedOk) {
        await Customer.collection.updateOne({ _id: doc._id }, { $set: { createdAt: new Date(), updatedAt: new Date() } });
        fixed++;
        fixedNames.push(doc.name);
      }
    }
    res.json({ fixed, fixedNames });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
              
