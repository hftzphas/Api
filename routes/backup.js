const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const AdmZip = require('adm-zip');
const Transaction = require('../models/Transaction');
const Product = require('../models/Product');
const Customer = require('../models/Customer');
const Setting = require('../models/Setting');
const { sendTelegramDocument, sendTelegramNotif, escapeHtmlForTelegram: esc } = require('../lib/telegram');
const { requireAdmin } = require('../lib/authLib');
const { logActivity } = require('../lib/activityLogLib');

// Cegah CSV/Formula Injection (OWASP): kalau cell diawali =, +, -, @ (atau
// tab/CR), spreadsheet app (Excel/Sheets) bisa nganggep itu formula pas
// file-nya dibuka -- bahaya kalau isinya berasal dari input user (nama
// barang, nama pelanggan, dll). Prefix dengan kutip satu (') biar dipaksa
// jadi teks literal, bukan formula.
function sanitizeCsvCell(s) {
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

function toCsv(rows) {
  return rows.map(r => r.map(cell => {
    let s = String(cell ?? '');
    s = sanitizeCsvCell(s);
    return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(';')).join('\r\n');
}

function formatDate(d) {
  return new Date(d).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Jakarta' });
}

// Tag tanggal buat nama file backup -- pakai kalender WIB (bukan UTC), biar
// backup yang jalan pas tengah malam WIB (mis. cron mingguan jam 00:00 WIB =
// 17:00 UTC hari sebelumnya) namanya nunjukkin tanggal yang orang kasir
// harepin, bukan tanggal UTC yang masih "kemarin".
function todayTagWib() {
  const shifted = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Bentuk snapshot LENGKAP database -- dipakai bareng oleh 3 tempat: backup
// Telegram (ikut dizip jadi salah satu file), GET /backup/export (download
// manual), dan performNeonBackup (cloud). Disatukan di sini supaya ketiganya
// selalu punya bentuk & isi yang identik -- dulu /export dan Telegram masing-
// masing query sendiri-sendiri, rawan beda kalau salah satu diubah tapi yang
// lain kelupaan.
async function buildFullSnapshot() {
  const [products, customers, transactions, settings] = await Promise.all([
    Product.find().lean(),
    Customer.find().lean(),
    Transaction.find().lean(),
    Setting.find().lean()
  ]);
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    counts: { products: products.length, customers: customers.length, transactions: transactions.length, settings: settings.length },
    data: { products, customers, transactions, settings }
  };
}

// Logic inti backup dipisah dari handler HTTP-nya supaya bisa dipanggil dari
// dua tempat: tombol manual (POST /telegram, butuh login admin) dan cron
// mingguan (lewat endpoint terpisah yang otentikasinya pakai CRON_SECRET,
// bukan JWT -- lihat api/index.js). Return value-nya {ok, counts} atau
// melempar error, BUKAN nulis ke res langsung, biar reusable.
async function performTelegramBackup(requestStartedAt = Date.now(), isAuto = false) {
  const [transactions, products, customers, settings] = await Promise.all([
      Transaction.find().sort({ createdAt: 1 }),
      Product.find().collation({ locale: 'id', strength: 2 }).sort({ name: 1 }),
      Customer.find().collation({ locale: 'id', strength: 2 }).sort({ name: 1 }),
      Setting.find().lean()
    ]);

    const dateTag = todayTagWib();

    const txRows = [['Tanggal', 'Kasir', 'Metode', 'Item', 'Qty', 'Harga', 'Subtotal', 'Total Transaksi', 'Diskon', 'Bayar', 'Kembalian', 'Pelanggan', 'Utang']];
    transactions.forEach(tx => {
      const dateStr = formatDate(tx.createdAt);
      (tx.items || []).forEach((it, i) => {
        txRows.push([
          dateStr, tx.cashier || '', tx.paymentMethod || 'tunai',
          it.name, it.qty, it.price, it.subtotal,
          i === 0 ? tx.total : '', i === 0 ? (tx.discount || 0) : '', i === 0 ? tx.paid : '', i === 0 ? tx.change : '',
          i === 0 ? (tx.customerName || '') : '', i === 0 ? (tx.debtAmount || 0) : ''
        ]);
      });
    });

    const productRows = [['Nama', 'Kategori', 'Subkategori', 'Harga Jual', 'Harga Modal', 'Stok', 'Satuan', 'Barcode']];
    products.forEach(p => {
      if (p.variants && p.variants.length > 0) {
        p.variants.forEach(v => {
          productRows.push([`${p.name} - ${v.name}`, p.category || '', p.subcategory || '', v.price, v.costPrice || 0, v.stock, p.unit || '', v.barcode || '']);
        });
      } else {
        productRows.push([p.name, p.category || '', p.subcategory || '', p.price, p.costPrice || 0, p.stock, p.unit || '', p.barcode || '']);
      }
    });

    const custRows = [['Nama', 'Telepon', 'Sisa Utang', 'Tanggal Riwayat', 'Jenis', 'Jumlah', 'Catatan']];
    customers.forEach(c => {
      if (!c.history || c.history.length === 0) {
        custRows.push([c.name, c.phone || '', c.balance, '', '', '', '']);
      } else {
        c.history.forEach((h, i) => {
          custRows.push([
            i === 0 ? c.name : '', i === 0 ? (c.phone || '') : '', i === 0 ? c.balance : '',
            h.date ? formatDate(h.date) : '', h.type, h.amount, h.note || ''
          ]);
        });
      }
    });

    // Backup JSON lengkap -- sama isinya kayak GET /backup/export, disertakan
    // di kirim Telegram ini juga (bukan cuma CSV) supaya kalau sewaktu-waktu
    // perlu restore, ada file JSON yang bisa langsung dipakai lewat tombol
    // Restore, gak cuma CSV yang sifatnya baca-doang.
    const jsonBackup = await buildFullSnapshot();

    // Semua 4 file digabung jadi SATU zip, terus dikirim sekali aja ke
    // Telegram -- sebelumnya dikirim 4 file terpisah secara paralel, dan
    // yang paling gede (JSON, ~1-2MB) sering timeout duluan. Dizip bareng
    // CSV yang kecil-kecil bikin ukuran total jauh lebih kecil (zip
    // ngompres teks dengan baik) dan cuma butuh 1x upload, bukan 4x.
    const zip = new AdmZip();
    zip.addFile(`transaksi-${dateTag}.csv`, Buffer.from('\uFEFF' + toCsv(txRows), 'utf-8'));
    zip.addFile(`barang-${dateTag}.csv`, Buffer.from('\uFEFF' + toCsv(productRows), 'utf-8'));
    zip.addFile(`hutang-${dateTag}.csv`, Buffer.from('\uFEFF' + toCsv(custRows), 'utf-8'));
    zip.addFile(`kasir-hnk-backup-${dateTag}.json`, Buffer.from(JSON.stringify(jsonBackup, null, 2), 'utf-8'));
    const zipBuffer = zip.toBuffer();

    const sent = await sendTelegramDocument(
      `kasir-hnk-backup-${dateTag}.zip`,
      zipBuffer,
      `📦 Backup lengkap (${transactions.length} transaksi · ${products.length} barang · ${customers.length} pelanggan)\nIsi zip: 3 CSV (transaksi/barang/hutang) + 1 JSON (buat Restore, extract dulu)`,
      'application/zip',
      requestStartedAt
    );

    if (!sent) {
      const err = new Error('Gagal kirim backup ke Telegram (biasanya karena koneksi lambat/timeout, jarang soal konfigurasi). Coba lagi -- kalau berulang kali gagal, baru cek TELEGRAM_BOT_TOKEN & TELEGRAM_CHAT_ID.');
      err.code = 'BACKUP_SEND_FAILED';
      throw err;
    }

    // BUG FIX: pesan sukses ini sebelumnya sama persis mau dipicu cron
    // mingguan ATAU tombol manual "Kirim Backup ke Telegram" di Pengaturan --
    // gak ada cara bedain di riwayat chat mana yang jalan otomatis vs mana
    // yang sengaja dipencet. `isAuto` nentuin labelnya.
    await sendTelegramNotif(`✅ <b>${isAuto ? 'Auto Backup' : 'Backup'} selesai</b>\n${formatDate(new Date())}\n${transactions.length} transaksi · ${products.length} barang · ${customers.length} pelanggan`);
    return { counts: { transactions: transactions.length, products: products.length, customers: customers.length } };
}

router.post('/telegram', requireAdmin, async (req, res) => {
  const requestStartedAt = Date.now();
  try {
    const result = await performTelegramBackup(requestStartedAt);
    res.json({ success: true, counts: result.counts });
  } catch (err) {
    res.status(err.code === 'BACKUP_SEND_FAILED' ? 500 : 500).json({ error: err.message });
  }
});

// --- Backup dua arah: sebelumnya cuma bisa export CSV ke Telegram (dilihat
// doang, gak bisa "dikembalikan" kalau database ke-hapus/corrupt). Dua
// endpoint di bawah ini bikin backup itu beneran bisa dipulihkan:
// - GET /backup/export  -> download 1 file JSON isi seluruh database
// - POST /backup/import -> upload file JSON itu balik, GANTI TOTAL isi
//   database dengan isi file (bukan digabung/merge)
// Keduanya requireAdmin secara eksplisit (bukan cuma requireAuth kayak
// endpoint backup lain) karena restore itu operasi destruktif.

router.get('/export', requireAdmin, async (req, res) => {
  try {
    res.json(await buildFullSnapshot());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Logic inti restore dipisah dari handler /import supaya bisa dipanggil juga
// dari /cloud/restore/:id (restore dari snapshot Neon) -- keduanya berujung
// pada operasi yang SAMA PERSIS (ganti total isi 4 koleksi), cuma sumber
// datanya beda (file upload vs snapshot Neon). req dioper apa adanya cuma
// buat logActivity (butuh req.user, req.ip, dll).
async function applyRestore(req, data) {
  const { products = [], customers = [], transactions = [], settings = [] } = data || {};
  if (!Array.isArray(products) || !Array.isArray(customers) || !Array.isArray(transactions) || !Array.isArray(settings)) {
    const err = new Error('Data restore tidak valid (format products/customers/transactions/settings harus array)');
    err.code = 'INVALID_DATA';
    throw err;
  }

  // Kosongin dulu semua koleksi baru diisi ulang dari data restore. _id
  // asli tetep dipakai (bukan dibuat baru) supaya relasi antar dokumen
  // (transaksi -> productId/customerId) tetap nyambung setelah restore.
  // Semua ini jalan dalam satu transaction: kalau ada error di tengah
  // (misal salah satu insertMany gagal karena data korup), SEMUA perubahan
  // di-rollback otomatis -- data lama gak ikut kehapus percuma.
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await Product.deleteMany({}, { session });
      await Customer.deleteMany({}, { session });
      await Transaction.deleteMany({}, { session });
      await Setting.deleteMany({}, { session });
      if (products.length) await Product.insertMany(products, { session });
      if (customers.length) await Customer.insertMany(customers, { session });
      if (transactions.length) await Transaction.insertMany(transactions, { session });
      if (settings.length) await Setting.insertMany(settings, { session });
    });
  } finally {
    await session.endSession();
  }

  const counts = { products: products.length, customers: customers.length, transactions: transactions.length, settings: settings.length };
  await logActivity(req, 'restore_backup', `${counts.products} barang, ${counts.customers} pelanggan, ${counts.transactions} transaksi, ${counts.settings} setting`);
  await sendTelegramNotif(`⚠️ <b>Restore backup dijalankan</b>\noleh ${esc(req.user.name)}\n${counts.products} barang · ${counts.customers} pelanggan · ${counts.transactions} transaksi dipulihkan`);
  return counts;
}

router.post('/import', requireAdmin, async (req, res) => {
  try {
    // Restore itu MENGHAPUS semua data yang ada sekarang lalu ganti dengan
    // isi file backup -- gak main-main, jadi wajib kirim confirm string
    // persis ini biar gak kepencet gak sengaja lewat request iseng/salah klik.
    // Ini pengaman DI LEVEL API, terpisah dari dialog "ketik untuk konfirmasi"
    // yang ada di frontend -- dua lapis, bukan cuma andalin satu sisi.
    if (req.body.confirm !== 'GANTI_SEMUA_DATA') {
      return res.status(400).json({ error: 'Restore akan MENGGANTI SEMUA data yang ada sekarang dengan isi file backup. Kirim confirm: "GANTI_SEMUA_DATA" untuk melanjutkan.' });
    }
    const data = req.body.data;
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'File backup tidak valid (field "data" tidak ada)' });
    }
    const restored = await applyRestore(req, data);
    res.json({ success: true, restored });
  } catch (err) {
    res.status(500).json({ error: 'Restore gagal, data lama tidak berubah: ' + err.message });
  }
});

// --- Backup cloud (Neon) -- alternatif dari backup Telegram: kesimpen di
// database, bukan dikirim jadi file, jadi bisa langsung dipulihkan lewat
// tombol tanpa perlu download-upload manual. Lihat lib/neon.js.

async function performNeonBackup(isAuto = false) {
  const { saveSnapshot } = require('../lib/neon');
  const snapshot = await buildFullSnapshot();
  await saveSnapshot(snapshot);
  // BUG FIX: sebelumnya cuma ada notif Telegram kalau backup Neon GAGAL
  // (lihat catch block di /cron/backup-neon, api/index.js) -- gak ada
  // konfirmasi apa-apa kalau berhasil, beda sama performTelegramBackup() di
  // atas yang udah dua-duanya (✅ sukses & 🚨 gagal). Disamain di sini biar
  // konsisten -- notif ini otomatis ikut kepakai baik dari cron mingguan
  // MAUPUN tombol manual "Backup Sekarang ke Cloud" di Pengaturan, karena
  // keduanya manggil fungsi performNeonBackup() yang sama ini.
  const c = snapshot.counts;
  await sendTelegramNotif(`✅ <b>${isAuto ? 'Auto Backup' : 'Backup'} cloud (Neon) selesai</b>\n${formatDate(new Date())}\n${c.transactions} transaksi · ${c.products} barang · ${c.customers} pelanggan`);
  return { counts: snapshot.counts };
}

router.get('/cloud/list', requireAdmin, async (req, res) => {
  try {
    const { listSnapshots } = require('../lib/neon');
    const rows = await listSnapshots();
    res.json({ snapshots: rows.map(r => ({ id: r.id, createdAt: r.created_at, counts: r.counts })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Backup manual ke Neon -- tombol "Backup Sekarang ke Cloud" di Pengaturan,
// setara sama tombol backup Telegram manual, buat kasus mau ada snapshot
// segar sebelum ngelakuin sesuatu yang beresiko (import massal, dll), gak
// perlu nunggu cron mingguan.
router.post('/cloud/save', requireAdmin, async (req, res) => {
  try {
    const result = await performNeonBackup();
    res.json({ success: true, counts: result.counts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/cloud/restore/:id', requireAdmin, async (req, res) => {
  try {
    // Sama kayak /import: wajib confirm string persis, DI LUAR dialog ketik
    // konfirmasi yang udah ditampilin frontend -- pengaman dobel.
    if (req.body.confirm !== 'GANTI_SEMUA_DATA') {
      return res.status(400).json({ error: 'Restore akan MENGGANTI SEMUA data yang ada sekarang. Kirim confirm: "GANTI_SEMUA_DATA" untuk melanjutkan.' });
    }
    const { getSnapshotData } = require('../lib/neon');
    const data = await getSnapshotData(Number(req.params.id));
    if (!data) {
      return res.status(404).json({ error: 'Snapshot tidak ditemukan (mungkin sudah terhapus otomatis karena kepenuhan)' });
    }
    const restored = await applyRestore(req, data);
    res.json({ success: true, restored });
  } catch (err) {
    res.status(500).json({ error: 'Restore gagal, data lama tidak berubah: ' + err.message });
  }
});

// performTelegramBackup & performNeonBackup diekspor terpisah supaya bisa
// dipanggil dari endpoint cron di api/index.js, yang otentikasinya beda
// (CRON_SECRET, bukan JWT admin) dan sengaja dipasang DI LUAR router ini
// biar gak ikut ke-guard requireAuth.
module.exports = router;
module.exports.performTelegramBackup = performTelegramBackup;
module.exports.performNeonBackup = performNeonBackup;
