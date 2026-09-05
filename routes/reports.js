const express = require('express');
const router = express.Router();
const Transaction = require('../models/Transaction');

// PENTING: perhitungan berat (jumlahin ratusan/ribuan transaksi & item) di
// endpoint ini sekarang dikerjain MongoDB lewat aggregation pipeline
// ($group/$facet), bukan ditarik semua ke memory Node lalu di-reduce kayak
// sebelumnya. Node cuma beresin hasil yang udah keciil (nge-sort & format
// angka). Ini gak bisa dites ke MongoDB beneran di lingkungan yang dipakai
// nulis kode ini -- disarankan dicoba dulu di data staging/kecil sebelum
// dipercaya penuh di production.

// Laporan itu dipakai orang Indonesia liat "hari ini/minggu ini/bulan ini"
// dalam WIB, tapi server (Vercel) jalan di UTC. new Date()+setHours(0,0,0,0)
// polos itu ngambil batas hari menurut jam SERVER (UTC), bukan WIB -- akibatnya
// "Hari Ini" baru keganti/reset jam 07:00 WIB (=00:00 UTC), bukan tengah malam
// WIB kayak yang orang harepin (data kemarin masih keitung "hari ini" sampe
// jam 7 pagi). WIB gak kenal DST, offset-nya tetep +7 jam sepanjang tahun,
// jadi aman dihardcode -- gak perlu library timezone buat ini.
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

// Geser instant UTC sekarang maju 7 jam, lalu baca field getUTCFullYear/
// Month/Date/Day-nya: field itu jadi merepresentasikan tanggal & hari-dalam-
// minggu versi WIB (trik umum buat "lihat jam di timezone lain" tanpa lib).
function nowAsWibFields() {
  return new Date(Date.now() + WIB_OFFSET_MS);
}

// Kebalikannya: dari Y/M/D yang udah dianggap "tanggal WIB", hitung instant
// UTC asli buat jam tertentu (00:00:00.000 atau 23:59:59.999) di tanggal itu.
function wibDateToUtcInstant(y, m, d, h, min, s, ms) {
  return new Date(Date.UTC(y, m, d, h, min, s, ms) - WIB_OFFSET_MS);
}

function getRangeStart(range) {
  const wib = nowAsWibFields();
  if (range === 'today') {
    return wibDateToUtcInstant(wib.getUTCFullYear(), wib.getUTCMonth(), wib.getUTCDate(), 0, 0, 0, 0);
  } else if (range === 'week') {
    const day = wib.getUTCDay();
    const diff = day === 0 ? 6 : day - 1;
    const d = new Date(wib);
    d.setUTCDate(d.getUTCDate() - diff);
    return wibDateToUtcInstant(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
  } else if (range === 'month') {
    return wibDateToUtcInstant(wib.getUTCFullYear(), wib.getUTCMonth(), 1, 0, 0, 0, 0);
  }
  return wibDateToUtcInstant(2000, 0, 1, 0, 0, 0, 0);
}

// Parsing "YYYY-MM-DD" dari query custom range: `new Date('YYYY-MM-DD')` per
// spec ES selalu di-parse sebagai UTC 00:00 tanggal itu, jadi field
// getUTCFullYear/Month/Date-nya PERSIS sama kayak yang diketik/dipilih user
// di date picker (gak butuh geser +7 jam kayak nowAsWibFields, soalnya ini
// bukan "jam sekarang" yang perlu dikonversi -- ini udah berupa tanggal
// kalender polos). Tinggal anggep Y/M/D itu tanggal WIB & hitung batas
// awal/akhir harinya di WIB.
function parseWibDateBoundary(str, isEnd) {
  const d = new Date(str);
  if (isNaN(d)) return d;
  return isEnd
    ? wibDateToUtcInstant(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999)
    : wibDateToUtcInstant(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
}

// Resolusi rentang tanggal: query ?start=YYYY-MM-DD&end=YYYY-MM-DD (custom,
// prioritas tertinggi kalau dikirim) atau ?range=today|week|month (default).
// end bersifat inklusif (dibulatkan ke akhir hari itu, 23:59:59.999).
class ReportInputError extends Error {}

function resolveDateRange(req) {
  // Kalau start/end custom dikirim TANPA range eksplisit, jangan default ke
  // 'today' -- itu dipakai buat nentuin chart per JAM vs per HARI di bawah,
  // jadi custom range 1 bulan misalnya bisa salah keitung per jam (data 1
  // jam yang sama numpuk dari tanggal beda-beda, ngaco). Default ke 'custom'
  // (dianggap kayak range panjang -> chart per hari), bukan 'today'.
  const range = req.query.range || (req.query.start ? 'custom' : 'today');
  let start;
  if (req.query.start) {
    start = parseWibDateBoundary(req.query.start, false);
    if (isNaN(start)) throw new ReportInputError('Parameter "start" bukan tanggal yang valid');
  } else {
    start = getRangeStart(range);
  }

  let end = null;
  if (req.query.end) {
    end = parseWibDateBoundary(req.query.end, true);
    if (isNaN(end)) throw new ReportInputError('Parameter "end" bukan tanggal yang valid');
  }

  if (end) {
    const days = (end - start) / 86400000;
    if (days > 366) {
      throw new ReportInputError('Rentang laporan maksimal 366 hari');
    }
  }

  return { range, start, end };
}

function reportErrorStatus(err) {
  return err instanceof ReportInputError ? 400 : 500;
}

function buildMatchStage(start, end, extraMatch) {
  const createdAt = { $gte: start };
  if (end) createdAt.$lte = end;
  return Object.assign({ createdAt, status: { $ne: 'void' } }, extraMatch || {});
}

// Bulatin angka uang di hasil akhir (jumlah dokumen yang udah di-aggregate
// jauh lebih kecil dari jumlah transaksi mentah, jadi aman dilakuin di JS).
function round(n) { return Math.round(n || 0); }

router.get('/summary', async (req, res) => {
  try {
    const { range, start, end } = resolveDateRange(req);
    const filterCategory = req.query.category;
    const filterSubcategory = req.query.subcategory;

    const match = buildMatchStage(start, end);

    // Kalau ada filter kategori: cuma transaksi yang punya MINIMAL 1 item
    // sesuai kategori itu yang ikut dihitung (persis kayak logika lama),
    // tapi omzet/jumlahTransaksi/dll tetap pakai TOTAL PENUH transaksi itu
    // (bukan cuma subtotal item yang match) -- item yang match dipakai
    // khusus buat topItems & byCategory di bawah.
    const itemsFieldExpr = filterCategory
      ? {
          $filter: {
            input: '$items',
            as: 'it',
            cond: {
              $and: [
                { $eq: [{ $ifNull: ['$$it.category', 'Tanpa Kategori'] }, filterCategory] },
                filterSubcategory
                  ? { $eq: [{ $ifNull: ['$$it.subcategory', ''] }, filterSubcategory] }
                  : { $literal: true }
              ]
            }
          }
        }
      : '$items';

    const pipeline = [
      { $match: match },
      { $addFields: { matchedItems: itemsFieldExpr } }
    ];
    if (filterCategory) {
      pipeline.push({ $match: { $expr: { $gt: [{ $size: '$matchedItems' }, 0] } } });
    }

    pipeline.push({
      $facet: {
        overview: [
          {
            $group: {
              _id: null,
              omzet: { $sum: { $subtract: ['$total', { $ifNull: ['$returnedAmount', 0] }] } },
              jumlahTransaksi: { $sum: 1 },
              totalUtangBaru: { $sum: { $ifNull: ['$debtAmount', 0] } },
              totalDiskon: { $sum: { $ifNull: ['$discount', 0] } },
              totalRetur: { $sum: { $ifNull: ['$returnedAmount', 0] } }
            }
          }
        ],
        perKasir: [
          {
            $group: {
              _id: { $ifNull: ['$cashier', 'Tanpa nama'] },
              jumlahTransaksi: { $sum: 1 },
              omzet: { $sum: { $subtract: ['$total', { $ifNull: ['$returnedAmount', 0] }] } }
            }
          }
        ],
        chart: range === 'today'
          ? [
              {
                $group: {
                  _id: { $dateToString: { format: '%H:00', date: '$createdAt', timezone: 'Asia/Jakarta' } },
                  value: { $sum: { $subtract: ['$total', { $ifNull: ['$returnedAmount', 0] }] } }
                }
              }
            ]
          : [
              {
                $group: {
                  _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Jakarta' } },
                  value: { $sum: { $subtract: ['$total', { $ifNull: ['$returnedAmount', 0] }] } }
                }
              }
            ],
        // PENTING: MongoDB gak ngizinin $facet nested di dalam $facet lain
        // (percobaan pertama nulis ini nge-group topItems & byCategory dalam
        // 1 branch "itemStats" yang isinya $facet lagi -- ditolak server
        // dengan error "$facet is not allowed to be used within a $facet
        // stage"). Makanya topItems & byCategory dipisah jadi 2 branch
        // SEJAJAR di sini, masing-masing $unwind & itung netQty/netTotal
        // sendiri-sendiri -- sedikit kerja dobel dibanding 1 unwind bersama,
        // tapi itu emang cara yang valid buat pola ini di aggregation pipeline.
        topItems: [
          { $unwind: '$matchedItems' },
          { $addFields: { 'matchedItems.netQty': { $max: [0, { $subtract: ['$matchedItems.qty', { $ifNull: ['$matchedItems.returnedQty', 0] }] }] } } },
          { $match: { 'matchedItems.netQty': { $gt: 0 } } },
          {
            $addFields: {
              'matchedItems.netTotal': {
                $multiply: [
                  { $ifNull: ['$matchedItems.subtotal', 0] },
                  { $divide: ['$matchedItems.netQty', { $cond: [{ $gt: ['$matchedItems.qty', 0] }, '$matchedItems.qty', '$matchedItems.netQty'] }] }
                ]
              }
            }
          },
          { $group: { _id: '$matchedItems.name', qty: { $sum: '$matchedItems.netQty' }, total: { $sum: '$matchedItems.netTotal' } } },
          { $sort: { qty: -1 } },
          { $limit: 10 }
        ],
        byCategory: [
          { $unwind: '$matchedItems' },
          { $addFields: { 'matchedItems.netQty': { $max: [0, { $subtract: ['$matchedItems.qty', { $ifNull: ['$matchedItems.returnedQty', 0] }] }] } } },
          { $match: { 'matchedItems.netQty': { $gt: 0 } } },
          {
            $addFields: {
              'matchedItems.netTotal': {
                $multiply: [
                  { $ifNull: ['$matchedItems.subtotal', 0] },
                  { $divide: ['$matchedItems.netQty', { $cond: [{ $gt: ['$matchedItems.qty', 0] }, '$matchedItems.qty', '$matchedItems.netQty'] }] }
                ]
              }
            }
          },
          {
            $group: {
              _id: {
                category: { $ifNull: ['$matchedItems.category', 'Tanpa Kategori'] },
                subcategory: { $ifNull: ['$matchedItems.subcategory', ''] }
              },
              qty: { $sum: '$matchedItems.netQty' },
              omzet: { $sum: '$matchedItems.netTotal' }
            }
          }
        ]
      }
    });

    const [result] = await Transaction.aggregate(pipeline);

    const overview = (result.overview && result.overview[0]) || { omzet: 0, jumlahTransaksi: 0, totalUtangBaru: 0, totalDiskon: 0, totalRetur: 0 };
    const perKasir = (result.perKasir || [])
      .map(c => ({ name: c._id, jumlahTransaksi: c.jumlahTransaksi, omzet: round(c.omzet) }))
      .sort((a, b) => b.omzet - a.omzet);

    const chartRaw = (result.chart || []).map(c => ({ key: c._id, value: round(c.value) }));
    let chartData;
    if (range === 'today') {
      chartData = chartRaw.map(c => ({ label: c.key, value: c.value })).sort((a, b) => a.label.localeCompare(b.label));
    } else {
      chartData = chartRaw
        .sort((a, b) => a.key.localeCompare(b.key))
        .map(c => ({
          label: new Date(`${c.key}T00:00:00+07:00`).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', timeZone: 'Asia/Jakarta' }),
          value: c.value
        }));
    }

    const topItems = (result.topItems || [])
      .map(it => ({ name: it._id, qty: it.qty, total: round(it.total) }))
      .sort((a, b) => b.qty - a.qty);

    const catMap = {};
    (result.byCategory || []).forEach(row => {
      const cat = row._id.category;
      const sub = row._id.subcategory;
      if (!catMap[cat]) catMap[cat] = { category: cat, qty: 0, omzet: 0, subcategories: [] };
      catMap[cat].qty += row.qty;
      catMap[cat].omzet += row.omzet;
      catMap[cat].subcategories.push({ subcategory: sub, qty: row.qty, omzet: round(row.omzet) });
    });
    const byCategory = Object.values(catMap)
      .map(c => ({ ...c, omzet: round(c.omzet), subcategories: c.subcategories.sort((a, b) => b.omzet - a.omzet) }))
      .sort((a, b) => b.omzet - a.omzet);

    res.json({
      range,
      omzet: round(overview.omzet),
      jumlahTransaksi: overview.jumlahTransaksi,
      totalUtangBaru: round(overview.totalUtangBaru),
      totalDiskon: round(overview.totalDiskon),
      totalRetur: round(overview.totalRetur),
      topItems,
      perKasir,
      chartData,
      byCategory
    });
  } catch (err) {
    res.status(reportErrorStatus(err)).json({ error: err.message });
  }
});

router.get('/profit', async (req, res) => {
  try {
    const { range, start, end } = resolveDateRange(req);
    const match = buildMatchStage(start, end);

    const pipeline = [
      { $match: match },
      {
        $addFields: {
          discFactor: { $cond: [{ $gt: ['$subtotal', 0] }, { $divide: ['$total', '$subtotal'] }, 1] }
        }
      },
      { $unwind: '$items' },
      {
        $addFields: {
          'items.netQty': { $max: [0, { $subtract: ['$items.qty', { $ifNull: ['$items.returnedQty', 0] }] }] }
        }
      },
      { $match: { 'items.netQty': { $gt: 0 } } },
      {
        $addFields: {
          'items.unitPrice': { $cond: [{ $gt: ['$items.qty', 0] }, { $divide: [{ $ifNull: ['$items.subtotal', 0] }, '$items.qty'] }, 0] }
        }
      },
      {
        $addFields: {
          'items.rev': { $multiply: ['$items.unitPrice', '$items.netQty', '$discFactor'] },
          'items.costTotal': { $multiply: [{ $ifNull: ['$items.costPrice', 0] }, '$items.netQty'] }
        }
      },
      {
        $facet: {
          totals: [
            { $group: { _id: null, revenue: { $sum: '$items.rev' }, cost: { $sum: '$items.costTotal' } } }
          ],
          byProduct: [
            {
              $group: {
                _id: '$items.name',
                qty: { $sum: '$items.netQty' },
                revenue: { $sum: '$items.rev' },
                cost: { $sum: '$items.costTotal' }
              }
            }
          ],
          byCategory: [
            {
              $group: {
                _id: {
                  category: { $ifNull: ['$items.category', 'Tanpa Kategori'] },
                  subcategory: { $ifNull: ['$items.subcategory', ''] }
                },
                revenue: { $sum: '$items.rev' },
                cost: { $sum: '$items.costTotal' }
              }
            }
          ]
        }
      }
    ];

    const [result] = await Transaction.aggregate(pipeline);
    const totals = (result.totals && result.totals[0]) || { revenue: 0, cost: 0 };
    const revenue = totals.revenue || 0;
    const cost = totals.cost || 0;
    const profit = revenue - cost;
    const marginPct = revenue > 0 ? (profit / revenue) * 100 : 0;

    const byProduct = (result.byProduct || [])
      .map(p => ({ name: p._id, qty: p.qty, revenue: round(p.revenue), cost: round(p.cost), profit: round(p.revenue - p.cost) }))
      .sort((a, b) => b.profit - a.profit);

    const catMap = {};
    (result.byCategory || []).forEach(row => {
      const cat = row._id.category;
      const sub = row._id.subcategory;
      if (!catMap[cat]) catMap[cat] = { category: cat, revenue: 0, cost: 0, subcategories: [] };
      catMap[cat].revenue += row.revenue;
      catMap[cat].cost += row.cost;
      catMap[cat].subcategories.push({ subcategory: sub, revenue: round(row.revenue), cost: round(row.cost), profit: round(row.revenue - row.cost) });
    });
    const byCategory = Object.values(catMap)
      .map(c => ({
        category: c.category,
        revenue: round(c.revenue), cost: round(c.cost), profit: round(c.revenue - c.cost),
        subcategories: c.subcategories.sort((a, b) => b.profit - a.profit)
      }))
      .sort((a, b) => b.profit - a.profit);

    res.json({ range, revenue: round(revenue), cost: round(cost), profit: round(profit), marginPct, byProduct, byCategory });
  } catch (err) {
    res.status(reportErrorStatus(err)).json({ error: err.message });
  }
});

// --- Rekomendasi Restock Pintar ---
// Beda dari low_stock_threshold (satu angka rata buat semua barang), ini
// itung kecepatan jual MASING-MASING barang dari histori transaksi 30 hari
// terakhir, lalu prediksi "berapa hari lagi stok abis" berdasarkan
// kecepatan jual barang itu sendiri -- bukan angka generik. Barang yang
// gak ada histori jual (dailyVelocity = 0) gak bisa diprediksi, jadi
// sengaja DIABAIKAN di sini (bukan tanggung jawab fitur ini -- barang
// gak laku beda masalah dari barang mau abis).
const Product = require('../models/Product');

const RESTOCK_LOOKBACK_DAYS = 30;
const RESTOCK_TARGET_DAYS = 14; // saran qty restock = cukup buat 14 hari ke depan
const RESTOCK_WATCH_DAYS = 14;  // cuma tampilin barang yang diprediksi abis dalam N hari ini

router.get('/restock-suggestions', async (req, res) => {
  try {
    const since = new Date(Date.now() - RESTOCK_LOOKBACK_DAYS * 86400000);

    // Total terjual bersih (qty - qty yang diretur) per productId+variantId,
    // dijumlahin di level MongoDB (bukan ditarik semua transaksi ke Node)
    // biar tetap murah walau histori transaksinya udah banyak.
    const sales = await Transaction.aggregate([
      { $match: { createdAt: { $gte: since }, status: 'selesai' } },
      { $unwind: '$items' },
      {
        $group: {
          _id: { productId: '$items.productId', variantId: { $ifNull: ['$items.variantId', ''] } },
          netQty: { $sum: { $subtract: ['$items.qty', { $ifNull: ['$items.returnedQty', 0] }] } }
        }
      },
      { $match: { netQty: { $gt: 0 } } }
    ]);

    if (sales.length === 0) {
      return res.json({ lookbackDays: RESTOCK_LOOKBACK_DAYS, targetDays: RESTOCK_TARGET_DAYS, suggestions: [] });
    }

    const productIds = [...new Set(sales.map(s => String(s._id.productId)).filter(Boolean))];
    const products = await Product.find({ _id: { $in: productIds } }, 'name category stock variants._id variants.name variants.stock').lean();
    const productMap = new Map(products.map(p => [String(p._id), p]));

    const suggestions = [];
    for (const s of sales) {
      const product = productMap.get(String(s._id.productId));
      if (!product) continue; // barang udah dihapus tapi histori transaksinya masih ada -- lewati

      const dailyVelocity = s.netQty / RESTOCK_LOOKBACK_DAYS;
      const variantId = s._id.variantId;

      let label, stock;
      if (variantId) {
        const variant = (product.variants || []).find(v => String(v._id) === String(variantId));
        if (!variant) continue; // varian udah dihapus
        label = `${product.name} - ${variant.name}`;
        stock = variant.stock;
      } else {
        if (product.variants && product.variants.length > 0) continue; // produk induk yang sekarang udah punya varian -- stok induk gak dipakai lagi
        label = product.name;
        stock = product.stock;
      }

      const daysLeft = dailyVelocity > 0 ? stock / dailyVelocity : Infinity;
      if (daysLeft > RESTOCK_WATCH_DAYS) continue; // masih aman, gak perlu ditampilin

      const suggestedQty = Math.max(1, Math.ceil(dailyVelocity * RESTOCK_TARGET_DAYS - stock));
      suggestions.push({
        productId: String(s._id.productId),
        variantId: variantId || null,
        name: label,
        category: product.category || '',
        stock,
        dailyVelocity: Math.round(dailyVelocity * 100) / 100,
        daysLeft: Math.round(daysLeft * 10) / 10,
        suggestedQty
      });
    }

    suggestions.sort((a, b) => a.daysLeft - b.daysLeft);
    res.json({ lookbackDays: RESTOCK_LOOKBACK_DAYS, targetDays: RESTOCK_TARGET_DAYS, suggestions: suggestions.slice(0, 50) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
