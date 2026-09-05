const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const Product = require('../models/Product');
const Customer = require('../models/Customer');
const Setting = require('../models/Setting');
const { sendTelegramNotif, escapeHtmlForTelegram: esc } = require('../lib/telegram');
const { notifyEvent } = require('../lib/notify');
const { calcLinePrice, formatBreakdown } = require('../lib/pricingLib');
const { requireAdmin } = require('../lib/authLib');
const { logActivity } = require('../lib/activityLogLib');
const { validate } = require('../lib/validate');
const { transactionSchema } = require('../lib/schemas');

// Pagination berbasis page/limit (bukan cursor) -- cukup buat kebutuhan
// halaman Riwayat yang cuma butuh "muat lagi" mundur secara kronologis.
// Default (tanpa query param) sengaja tetap balikin array polos 300 item
// terbaru kayak sebelumnya, biar frontend lama yang belum di-update tetap
// jalan tanpa perlu ubah cara baca response-nya. Kalau ?page atau ?limit
// dikirim, baru dibalikin bentuk baru { data, page, limit, total, hasMore }.
router.get('/', async (req, res) => {
  try {
    const hasPagingParams = req.query.page !== undefined || req.query.limit !== undefined;
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 300));

    if (!hasPagingParams) {
      const transactions = await Transaction.find().sort({ createdAt: -1 }).limit(limit).lean();
      return res.json(transactions);
    }

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const skip = (page - 1) * limit;
    const [transactions, total] = await Promise.all([
      Transaction.find().sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Transaction.countDocuments()
    ]);
    res.json({ data: transactions, page, limit, total, hasMore: skip + transactions.length < total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const IMPORT_PAYMENT_METHODS = ['tunai', 'qris', 'bon', 'tarik_tunai', 'split'];

router.post('/bulk-import', requireAdmin, async (req, res) => {
  try {
    const { transactions } = req.body;
    if (!Array.isArray(transactions) || transactions.length === 0) {
      return res.status(400).json({ error: 'Tidak ada data yang diimpor' });
    }

    let created = 0;
    let skipped = 0;
    const errors = [];

    for (let i = 0; i < transactions.length; i++) {
      const row = transactions[i];
      try {
        const items = (Array.isArray(row.items) ? row.items : [])
          .map(it => ({
            name: String(it.name || '').trim(),
            qty: Number(it.qty) || 0,
            price: Number(it.price) || 0,
            subtotal: Number(it.subtotal) || 0
          }))
          .filter(it => it.name);
        if (items.length === 0) throw new Error('Baris tidak punya item barang yang valid');

        const createdAt = row.date ? new Date(row.date) : new Date();
        if (isNaN(createdAt)) throw new Error('Tanggal tidak valid');

        const subtotal = items.reduce((s, it) => s + it.subtotal, 0);
        const total = Number(row.total) || subtotal;
        const paid = row.paid !== undefined && row.paid !== '' ? Number(row.paid) || 0 : total;
        const change = Number(row.change) || 0;
        const discount = Number(row.discount) || 0;
        const debtAmount = Number(row.debtAmount) || 0;
        const cashier = String(row.cashier || '').trim();
        const customerName = String(row.customerName || '').trim();
        const paymentMethod = IMPORT_PAYMENT_METHODS.includes(row.paymentMethod) ? row.paymentMethod : 'tunai';
        const status = row.status === 'void' ? 'void' : 'selesai';

        const fingerprint = crypto.createHash('md5')
          .update(JSON.stringify({ createdAt: createdAt.toISOString(), cashier, total, paid, items }))
          .digest('hex');
        const clientTxId = `import-${fingerprint}`;

        const already = await Transaction.findOne({ clientTxId });
        if (already) { skipped++; continue; }

        await Transaction.create({
          clientTxId, items, subtotal, discount, total, paid, change,
          cashier, customerName, debtAmount, paymentMethod, status, createdAt
        });
        created++;
      } catch (err) {
        errors.push({ row: i + 1, error: err.message });
      }
    }

    res.json({ created, skipped, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

class CheckoutError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Batas atas qty per baris item -- gak ada toko kecil yang transaksi sekali
// jalan sampai ratusan ribu unit. Tanpa batas ini, item.manual (barang
// manual tanpa productId, jadi gak kena guard stok $gte di bawah) bisa
// dikirim dengan qty sembarang besar; produk biasa juga lewat calcLinePrice
// yang bikin array DP sepanjang qty -- keduanya lebih baik ditolak awal
// dengan pesan jelas daripada diproses/nyoba dialokasikan.
const MAX_ITEM_QTY = 100000;

router.post('/', validate(transactionSchema), async (req, res) => {
  const { items, paid, customerId, paymentMethod, paymentMethodLabel, payments, clientTxId, customerName } = req.body;
  // Nama pelanggan bebas ketik (bukan pelanggan bon terdaftar) -- dipakai
  // cuma kalau gak ada customerId (pelanggan bon selalu ambil nama dari
  // record Customer asli, lihat displayCustomerName di bawah).
  const guestCustomerName = String(customerName || '').trim().slice(0, 100);
  const cashier = req.user.name || req.user.username || '';
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Keranjang kosong' });
  }
  if (clientTxId) {
    const already = await Transaction.findOne({ clientTxId });
    if (already) return res.json(already); 
  }
  const decremented = [];
  let debtRollback = null;
  async function rollbackStock() {
    for (const d of decremented) {
      try {
        if (d.variantId) {
          await Product.updateOne({ _id: d.productId, 'variants._id': d.variantId }, { $inc: { 'variants.$.stock': d.qty } });
        } else {
          await Product.updateOne({ _id: d.productId }, { $inc: { stock: d.qty } });
        }
      } catch (e) {  }
    }
  }
  try {
    const txItems = [];
    const lowStockChecks = []; 
    for (const item of items) {
      if (item.manual) {
        const qty = Math.floor(Number(item.qty) || 0);
        const price = Number(item.price) || 0;
        const name = (item.name ? String(item.name).trim() : '').slice(0, 100) || 'Barang Lain';
        if (qty <= 0 || price <= 0) {
          throw new CheckoutError(400, `Barang manual "${name}" tidak valid`);
        }
        if (qty > MAX_ITEM_QTY) {
          throw new CheckoutError(400, `Jumlah barang manual "${name}" kebesaran (maks ${MAX_ITEM_QTY.toLocaleString('id-ID')})`);
        }
        txItems.push({
          name,
          price,
          costPrice: 0,
          qty,
          subtotal: price * qty,
          unit: '',
          priceNote: '',
          category: '',
          subcategory: ''
        });
        continue;
      }
      const product = await Product.findById(item.productId);
      if (!product) throw new CheckoutError(404, `Barang ${item.name} tidak ditemukan`);

      let variant = null;
      if (product.variants && product.variants.length > 0) {
        variant = item.variantId ? product.variants.id(item.variantId) : null;
        if (!variant) throw new CheckoutError(400, `Pilih varian untuk ${product.name}`);
      }
      const priceSource = variant || product;
      const displayName = variant ? `${product.name} - ${variant.name}` : product.name;

      const qty = Math.floor(Number(item.qty) || 0);
      if (qty <= 0) throw new CheckoutError(400, `Jumlah ${displayName} tidak valid`);
      if (qty > MAX_ITEM_QTY) {
        throw new CheckoutError(400, `Jumlah ${displayName} kebesaran (maks ${MAX_ITEM_QTY.toLocaleString('id-ID')})`);
      }

      const minSaleQty = Math.max(1, Math.floor(Number(priceSource.minSaleQty) || 1));
      if (qty % minSaleQty !== 0) {
        throw new CheckoutError(400, `${displayName} wajib dijual kelipatan ${minSaleQty} ${product.unit || ''}`.trim());
      }

      let updated;
      if (variant) {
        // BUG FIX: sama akar masalah kayak endpoint /stock manual di
        // products.js -- 'variants._id' + 'variants.stock' sebagai 2
        // kondisi terpisah di path array yang sama bikin operator posisi
        // `$` bisa salah pilih elemen varian yang di-update. Di checkout
        // ini dampaknya lebih parah dari tombol manual: bisa motong stok
        // VARIAN YANG SALAH pas transaksi beneran kejual, bukan cuma pas
        // orang pencet +/- di Kelola Barang.
        updated = await Product.findOneAndUpdate(
          { _id: product._id, variants: { $elemMatch: { _id: variant._id, stock: { $gte: qty } } } },
          { $inc: { 'variants.$.stock': -qty } },
          { new: true }
        );
      } else {
        updated = await Product.findOneAndUpdate(
          { _id: product._id, stock: { $gte: qty } },
          { $inc: { stock: -qty } },
          { new: true }
        );
      }
      if (!updated) throw new CheckoutError(400, `Stok ${displayName} tidak cukup`);
      decremented.push({ productId: product._id, variantId: variant ? variant._id : null, qty });

      const newStock = variant ? updated.variants.id(variant._id).stock : updated.stock;
      lowStockChecks.push({ label: displayName, stock: newStock, unit: product.unit || '' });

      const { total: subtotal, breakdown } = calcLinePrice(priceSource, qty);
      txItems.push({
        productId: product._id,
        variantId: variant ? String(variant._id) : '',
        name: displayName,
        price: priceSource.price,
        costPrice: priceSource.costPrice || 0,
        qty,
        subtotal,
        unit: product.unit,
        priceNote: breakdown.length > 1 || (breakdown[0] && breakdown[0].qty > 1)
          ? formatBreakdown(breakdown, product.unit)
          : '',
        category: product.category || '',
        subcategory: product.subcategory || ''
      });
    }

    const subtotal = txItems.reduce((sum, it) => sum + it.subtotal, 0);
    const discount = Math.max(0, Math.min(Number(req.body.discount) || 0, subtotal));
    const total = subtotal - discount;
    const paidAmount = Number(paid) || 0;

    // Alokasikan diskon transaksi ke tiap item secara proporsional terhadap
    // subtotal-nya, simpan hasilnya sebagai netSubtotal. Item TERAKHIR
    // nampung sisa pembulatan (bukan dihitung proporsional lagi) biar total
    // netSubtotal semua item selalu PERSIS sama dengan `total` -- gak ada
    // selisih rupiah yang ngilang/nambah gara-gara pembulatan per item.
    if (discount > 0 && subtotal > 0) {
      let allocatedSoFar = 0;
      txItems.forEach((it, idx) => {
        if (idx === txItems.length - 1) {
          it.netSubtotal = it.subtotal - (discount - allocatedSoFar);
        } else {
          const share = Math.round((it.subtotal / subtotal) * discount);
          it.netSubtotal = it.subtotal - share;
          allocatedSoFar += share;
        }
      });
    } else {
      txItems.forEach(it => { it.netSubtotal = it.subtotal; });
    }

    let customer = null;
    if (customerId) {
      customer = await Customer.findById(customerId);
      if (!customer) throw new CheckoutError(404, 'Pelanggan tidak ditemukan');
    }

    if (paidAmount < total && !customer) {
      throw new CheckoutError(400, 'Uang bayar kurang. Pilih pelanggan dulu kalau mau dicatat sebagai utang.');
    }

    // Nama yang bakal disimpan & tampil di struk: prioritas ke pelanggan bon
    // terdaftar (customer.name), fallback ke nama bebas yang diketik kasir.
    const displayCustomerName = customer ? customer.name : guestCustomerName;

    const debtAmount = Math.max(0, total - paidAmount);

    if (customer && debtAmount > 0) {
      // Atomic $inc, bukan baca-ubah-simpan, biar aman kalau ada request lain
      // (bayar utang / transaksi bon lain) nyentuh pelanggan yang sama bareng.
      const checkoutMarker = clientTxId || `checkout-${crypto.randomUUID()}`;
      await Customer.updateOne(
        { _id: customer._id },
        { $inc: { balance: debtAmount }, $push: { history: { type: 'utang', amount: debtAmount, note: 'Belanja di kasir', checkoutMarker } } }
      );
      debtRollback = { customerId: customer._id, amount: debtAmount, checkoutMarker };
    }

    let cleanedPayments = [];
    // Metode custom (dibuat admin lewat Pengaturan > Metode Pembayaran)
    // dikirim frontend dengan prefix "custom:" -- gak ada di whitelist tetap
    // karena daftarnya bisa berubah-ubah, cukup dicek pola prefix-nya aja.
    // Split-payment TETAP cuma tunai+qris (gak berubah, lihat filter payments
    // di bawah), metode custom cuma bisa dipakai sebagai pembayaran penuh.
    const isKnownMethod = ['tunai', 'qris', 'bon', 'tarik_tunai'].includes(paymentMethod) || /^custom:[a-z0-9-]{1,60}$/.test(paymentMethod || '');
    let finalMethod = isKnownMethod ? paymentMethod : 'tunai';
    if (Array.isArray(payments) && payments.length > 0) {
      cleanedPayments = payments
        .map(p => ({ method: p.method, amount: Number(p.amount) }))
        .filter(p => ['tunai', 'qris'].includes(p.method) && Number.isFinite(p.amount) && p.amount > 0);
      const sumSplit = cleanedPayments.reduce((s, p) => s + p.amount, 0);
      if (cleanedPayments.length > 0 && Math.abs(sumSplit - paidAmount) <= 1) {
        finalMethod = 'split';
      } else if (cleanedPayments.length > 0) {
        throw new CheckoutError(400, `Total split bayar (${sumSplit}) tidak sama dengan uang dibayar (${paidAmount})`);
      }
    }

    const transaction = await Transaction.create({
      clientTxId: clientTxId || undefined,
      items: txItems,
      subtotal,
      discount,
      total,
      paid: paidAmount,
      change: paidAmount > total ? paidAmount - total : 0,
      cashier: cashier,
      customerId: customer ? customer._id : undefined,
      customerName: displayCustomerName || undefined,
      debtAmount,
      paymentMethod: finalMethod,
      payments: cleanedPayments
    });

    const rp = n => 'Rp' + (n || 0).toLocaleString('id-ID');
    const dateStr = new Date().toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Jakarta' });
    const methodLabelMap = { tunai: 'Tunai', qris: 'QRIS', bon: 'Bon (Hutang)', tarik_tunai: 'Tarik Tunai', split: 'Split (' + cleanedPayments.map(p => (p.method === 'tunai' ? 'Tunai' : 'QRIS') + ' ' + rp(p.amount)).join(' + ') + ')' };
    // methodLabel: cabang bawaan (tunai/qris/dst) aman krn dari map tetap di
    // atas, tapi cabang "custom:" ngambil paymentMethodLabel langsung dari
    // req.body (nama metode custom bikinan admin, bebas ketik) -- WAJIB esc().
    const methodLabel = methodLabelMap[transaction.paymentMethod]
      || (transaction.paymentMethod.startsWith('custom:') ? esc(String(paymentMethodLabel || '').trim() || 'Lainnya') : 'Tunai');
    // it.name/it.unit/it.priceNote semuanya nyalin dari data produk yang bisa
    // diisi bebas kasir manapun (lihat routes/products.js) -- esc() semua,
    // BUKAN cuma nama produknya doang.
    const itemLines = transaction.items.map(it => {
      const detail = it.priceNote ? esc(it.priceNote) : `${it.qty} ${esc(it.unit || '')} x ${rp(it.price)}`;
      return `${esc(it.name)}\n  ${detail} = ${rp(it.subtotal)}`;
    }).join('\n');
    const struk = [
      '🧾 <b>STRUK KASIR H&K</b>',
      dateStr + (cashier ? ` · Kasir: ${esc(cashier)}` : ''),
      '------------------------------',
      itemLines,
      '------------------------------',
      discount > 0 ? `Subtotal: ${rp(subtotal)}` : null,
      discount > 0 ? `Diskon: -${rp(discount)}` : null,
      `<b>TOTAL: ${rp(total)}</b>`,
      `Bayar (${methodLabel}): ${rp(paidAmount)}`,
      displayCustomerName ? `Pelanggan: <b>${esc(displayCustomerName)}</b>` : null,
      debtAmount > 0
        ? `<b>Sisa Utang: ${rp(debtAmount)}</b>`
        : `Kembalian: ${rp(transaction.change)}`
    ].filter(Boolean).join('\n');
    // Semua setting terkait notif & threshold di-fetch sekali jalan (1 query)
    // biar gak nambah round-trip DB per jenis. Default semua notif "on" kalau
    // belum pernah di-set admin, biar behavior lama gak berubah tiba-tiba.
    const relevantSettings = await Setting.find({ key: { $in: ['low_stock_threshold', 'notif_struk', 'notif_stok_habis', 'notif_stok_menipis', 'notif_transaksi', 'notif_piutang'] } }).lean();
    const settingsMap = Object.fromEntries(relevantSettings.map(s => [s.key, s.value]));
    const notifOn = key => settingsMap[key] !== 'off'; // default on kecuali eksplisit di-off-in

    if (notifOn('notif_struk')) sendTelegramNotif(struk);
    if (notifOn('notif_transaksi')) {
      // Ringkasan item "Nama xQty" biar notif gak polos cuma nampilin
      // metode+total -- dibatasi 3 item pertama + "+N lainnya" biar tetap
      // muat 1 baris di notif log & push (gak di-esc() krn frontend notif
      // log yang nge-escapeHtml() pas render, beda dari struk Telegram).
      const itemSummary = transaction.items.slice(0, 3).map(it => `${it.name} x${it.qty}`).join(', ')
        + (transaction.items.length > 3 ? `, +${transaction.items.length - 3} lainnya` : '');
      notifyEvent({
        type: 'transaksi',
        title: 'Transaksi Baru',
        message: `${methodLabel} · ${rp(total)} · ${itemSummary}${displayCustomerName ? ` · ${displayCustomerName}` : ''}${cashier ? ` · ${cashier}` : ''}`,
        refId: transaction._id
      }).catch(() => {});
    }
    if (customer && debtAmount > 0 && notifOn('notif_piutang')) {
      notifyEvent({
        type: 'piutang_baru',
        title: 'Piutang Baru Dicatat',
        message: `${customer.name} · ${rp(debtAmount)}`,
        refId: transaction._id
      }).catch(() => {});
    }

    const LOW_STOCK_THRESHOLD = Number(settingsMap.low_stock_threshold) > 0 ? Number(settingsMap.low_stock_threshold) : 5;
    const outOfStockItems = lowStockChecks.filter(c => c.stock === 0);
    const lowStockItems = lowStockChecks.filter(c => c.stock > 0 && c.stock <= LOW_STOCK_THRESHOLD);
    if (outOfStockItems.length > 0 && notifOn('notif_stok_habis')) {
      const outList = outOfStockItems.map(c => `• ${esc(c.label)}`).join('\n');
      sendTelegramNotif(`🚨 <b>STOK HABIS</b>\n\n${outList}\n\nBarang ini udah gak bisa dijual sampai di-restock!`);
      notifyEvent({
        type: 'stok_habis',
        title: 'Stok Habis',
        message: outOfStockItems.map(c => c.label).join(', ')
      }).catch(() => {});
    }
    if (lowStockItems.length > 0 && notifOn('notif_stok_menipis')) {
      const lowList = lowStockItems.map(c => `• ${esc(c.label)}: sisa ${c.stock} ${esc(c.unit)}`).join('\n');
      sendTelegramNotif(`⚠️ <b>STOK MENIPIS</b>\n\n${lowList}\n\nSegera restock ya!`);
      notifyEvent({
        type: 'stok_menipis',
        title: 'Stok Menipis',
        message: lowStockItems.map(c => `${c.label} (sisa ${c.stock} ${c.unit})`).join(', ')
      }).catch(() => {});
    }

    res.status(201).json(transaction);
  } catch (err) {
    await rollbackStock();
    if (debtRollback) {
      try {
        await Customer.updateOne(
          { _id: debtRollback.customerId, 'history.checkoutMarker': debtRollback.checkoutMarker },
          {
            $inc: { balance: -debtRollback.amount },
            $pull: { history: { checkoutMarker: debtRollback.checkoutMarker } }
          }
        );
      } catch (rollbackErr) {
        console.error('[checkout] Gagal rollback utang pelanggan:', rollbackErr.message);
      }
    }
    if (err instanceof CheckoutError) {
      return res.status(err.status).json({ error: err.message });
    }
    if (err.code === 11000 && clientTxId) {
      const existing = await Transaction.findOne({ clientTxId });
      if (existing) return res.json(existing);
    }
    // Sampai sini berarti error BENERAN gak terduga (bukan validasi input
    // kayak stok kurang/barang gak ketemu yang udah ditangani CheckoutError
    // di atas) -- ini yang paling kritis karena transaksi (duit beneran) gagal
    // tersimpan. Stok sudah di-rollback di atas, tapi tetep worth dicek manual.
    sendTelegramNotif(`🚨 <b>Transaksi gagal tersimpan</b>\nKasir: ${esc(cashier || '-')}\nError: ${esc(err.message)}\n\nStok sudah di-rollback otomatis, tapi cek manual kalau perlu.`);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/void', requireAdmin, async (req, res) => {
  const { reason } = req.body;
  const voidedBy = req.user.name || req.user.username || '';
  const session = await mongoose.startSession();
  try {
    let transaction;

    await session.withTransaction(async () => {
      // findOneAndUpdate dengan filter status: 'selesai' di query -- bukan
      // findById lalu cek status di memory. Kalau dua request PATCH void
      // nembak bersamaan, cuma SATU yang bakal berhasil dapetin dokumen
      // dengan status masih 'selesai' (matchCount MongoDB level), yang
      // kedua bakal null di sini karena status udah 'void' duluan.
      transaction = await Transaction.findOneAndUpdate(
        { _id: req.params.id, status: 'selesai' },
        {
          $set: {
            status: 'void',
            voidedAt: new Date(),
            voidedBy: voidedBy || '',
            voidReason: reason || ''
          }
        },
        { new: false, session } // new:false -- kita butuh dokumen SEBELUM diubah buat tau item & qty yang mesti dikembalikan
      );

      if (!transaction) {
        const existing = await Transaction.findById(req.params.id).session(session);
        if (!existing) {
          const err = new Error('Transaksi tidak ditemukan');
          err.status = 404;
          throw err;
        }
        const err = new Error('Transaksi ini sudah di-void sebelumnya');
        err.status = 400;
        throw err;
      }

      for (const item of transaction.items) {
        if (!item.productId) continue;
        const remainingQty = item.qty - (item.returnedQty || 0);
        if (remainingQty <= 0) continue;
        if (item.variantId) {
          await Product.updateOne(
            { _id: item.productId, 'variants._id': item.variantId },
            { $inc: { 'variants.$.stock': remainingQty } },
            { session }
          );
        } else {
          await Product.updateOne(
            { _id: item.productId },
            { $inc: { stock: remainingQty } },
            { session }
          );
        }
      }

      const remainingDebt = Math.max(0, transaction.debtAmount - (transaction.debtRefunded || 0));
      if (transaction.customerId && remainingDebt > 0) {
        await Customer.updateOne(
          { _id: transaction.customerId },
          [
            { $set: { balance: { $max: [0, { $subtract: ['$balance', remainingDebt] }] } } },
            { $set: { history: { $concatArrays: ['$history', [{ type: 'bayar', amount: remainingDebt, note: 'Void transaksi (utang dibatalkan)' }]] } } }
          ],
          { session }
        );
      }

      // Refleksikan status baru di objek yang bakal dipakai buat response/notif,
      // karena `transaction` di atas masih versi SEBELUM update (new: false).
      transaction.status = 'void';
      transaction.voidedAt = new Date();
      transaction.voidedBy = voidedBy || '';
      transaction.voidReason = reason || '';
    });

    const rp = n => 'Rp' + (n || 0).toLocaleString('id-ID');
    sendTelegramNotif(
      [
        '🚫 <b>TRANSAKSI DI-VOID</b>',
        `Total: ${rp(transaction.total)}`,
        voidedBy ? `Oleh: ${esc(voidedBy)}` : null,
        reason ? `Alasan: ${esc(reason)}` : null,
        'Stok barang & utang (kalau ada) sudah dikembalikan.'
      ].filter(Boolean).join('\n')
    );
    const voidSetting = await Setting.findOne({ key: 'notif_transaksi' }).lean();
    if (!voidSetting || voidSetting.value !== 'off') {
      notifyEvent({
        type: 'transaksi_batal',
        title: 'Transaksi Di-void',
        message: `${rp(transaction.total)}${voidedBy ? ` · Oleh: ${voidedBy}` : ''}${reason ? ` · ${reason}` : ''}`,
        refId: transaction._id
      }).catch(() => {});
    }

    await logActivity(req, 'void_transaksi', String(transaction._id), `Total Rp${transaction.total.toLocaleString('id-ID')}${reason ? ' - ' + reason : ''}`);
    res.json(transaction);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : (err.message || 'Gagal memproses void transaksi') });
  } finally {
    await session.endSession();
  }
});

router.post('/:id/return', async (req, res) => {
  const { items, reason } = req.body;
  const returnedBy = req.user.name || req.user.username || '';
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Pilih minimal 1 barang yang mau diretur' });
  }

  const session = await mongoose.startSession();
  try {
    let transaction, returnItems, totalRefund;

    await session.withTransaction(async () => {
      // status: { $ne: 'void' } di query filter -- bukan cek status setelah
      // baca. Kalau transaksi ini kebetulan lagi di-void bersamaan sama
      // request retur ini, salah satu operasi bakal gagal dapetin dokumen
      // yang cocok, bukan dua-duanya jalan berdasarkan data yang udah basi.
      transaction = await Transaction.findOne(
        { _id: req.params.id, status: { $ne: 'void' } }
      ).session(session);

      if (!transaction) {
        const existing = await Transaction.findById(req.params.id).session(session);
        const err = new Error(existing ? 'Transaksi ini sudah di-void, tidak bisa diretur' : 'Transaksi tidak ditemukan');
        err.status = existing ? 400 : 404;
        throw err;
      }

      // Tahap 1: validasi SEMUA item dulu tanpa mutasi apapun. Kalau ada
      // satu aja yang gak valid, seluruh retur dibatalkan -- gak ada
      // kondisi separuh item ke-apply separuh enggak.
      const plannedReturns = [];
      for (const reqItem of items) {
        const qty = Math.floor(Number(reqItem.qty) || 0);
        if (qty <= 0) continue;
        const txItem = transaction.items.find(it =>
          it.productId && String(it.productId) === String(reqItem.productId) &&
          String(it.variantId || '') === String(reqItem.variantId || '')
        );
        if (!txItem) {
          const err = new Error('Barang tidak ditemukan di transaksi ini');
          err.status = 400;
          throw err;
        }
        const sisaBisaDiretur = txItem.qty - (txItem.returnedQty || 0);
        if (qty > sisaBisaDiretur) {
          const err = new Error(`${txItem.name}: retur melebihi sisa yang bisa diretur (maks ${sisaBisaDiretur})`);
          err.status = 400;
          throw err;
        }
        // netSubtotal = nilai bersih SETELAH diskon transaksi (lihat model).
        // Transaksi lama yang belum punya field ini fallback ke subtotal
        // mentah -- itu perilaku lama, cuma meleset kalau transaksinya
        // memang pakai diskon.
        const baseForRefund = txItem.netSubtotal != null ? txItem.netSubtotal : txItem.subtotal;
        const unitRefund = txItem.qty > 0 ? baseForRefund / txItem.qty : 0;
        const amount = Math.round(unitRefund * qty);
        plannedReturns.push({ txItem, qty, amount });
      }

      if (plannedReturns.length === 0) {
        const err = new Error('Tidak ada barang valid yang diretur');
        err.status = 400;
        throw err;
      }

      // Tahap 2: semua item valid, baru apply mutasi + update stok dalam
      // session yang sama.
      returnItems = [];
      totalRefund = 0;
      for (const { txItem, qty, amount } of plannedReturns) {
        txItem.returnedQty = (txItem.returnedQty || 0) + qty;
        totalRefund += amount;
        returnItems.push({ productId: txItem.productId, variantId: txItem.variantId || '', name: txItem.name, qty, amount });

        if (txItem.variantId) {
          await Product.updateOne(
            { _id: txItem.productId, 'variants._id': txItem.variantId },
            { $inc: { 'variants.$.stock': qty } },
            { session }
          );
        } else {
          await Product.updateOne(
            { _id: txItem.productId },
            { $inc: { stock: qty } },
            { session }
          );
        }
      }

      transaction.returns.push({ items: returnItems, amount: totalRefund, reason: reason || '', returnedBy: returnedBy || '', returnedAt: new Date() });
      transaction.returnedAmount = (transaction.returnedAmount || 0) + totalRefund;

      if (transaction.customerId && transaction.debtAmount > 0) {
        const sisaUtangTx = transaction.debtAmount - (transaction.debtRefunded || 0);
        const potongUtang = Math.min(totalRefund, Math.max(0, sisaUtangTx));
        if (potongUtang > 0) {
          await Customer.updateOne(
            { _id: transaction.customerId },
            [
              { $set: { balance: { $max: [0, { $subtract: ['$balance', potongUtang] }] } } },
              { $set: { history: { $concatArrays: ['$history', [{ type: 'bayar', amount: potongUtang, note: 'Retur barang' }]] } } }
            ],
            { session }
          );
          transaction.debtRefunded = (transaction.debtRefunded || 0) + potongUtang;
        }
      }

      await transaction.save({ session });
    });

    const rp = n => 'Rp' + (n || 0).toLocaleString('id-ID');
    const itemLines = returnItems.map(it => `• ${esc(it.name)} x${it.qty} = ${rp(it.amount)}`).join('\n');
    sendTelegramNotif(
      [
        '↩️ <b>RETUR BARANG</b>',
        itemLines,
        `Total retur: ${rp(totalRefund)}`,
        returnedBy ? `Oleh: ${esc(returnedBy)}` : null,
        reason ? `Alasan: ${esc(reason)}` : null
      ].filter(Boolean).join('\n')
    );

    res.json(transaction);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : (err.message || 'Gagal memproses retur') });
  } finally {
    await session.endSession();
  }
});

router.delete('/', requireAdmin, async (req, res) => {
  try {
    await Transaction.deleteMany({});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
              
