const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const { escapeRegex, parseBarcodes, joinBarcodes, hasBarcode, barcodeVariants, findAllVariantsByBarcode, findCorruptedBarcode } = require('../lib/barcodeLib');
const { logActivity } = require('../lib/activityLogLib');
const { requireAdmin } = require('../lib/authLib');
const { uploadToImgBB } = require('../lib/imgbb');
const { uploadToImageKit } = require('../lib/imagekit');
const { getMigrationStatus, runMigrationBatch } = require('../lib/imageMigration');
const { validate } = require('../lib/validate');
const { productSchema } = require('../lib/schemas');

function validateImageUrl(imageUrl) {
  if (!imageUrl.startsWith('data:')) return null; 
  if (!/^data:image\/(png|jpe?g|webp);base64,/.test(imageUrl)) {
    return 'Format foto tidak valid (harus PNG/JPEG/WebP)';
  }
  if (imageUrl.length > 1_500_000) {
    return 'Ukuran foto terlalu besar (maks ~1MB setelah di-encode)';
  }
  return null;
}

// priceHistory (produk & tiap varian) sengaja di-exclude dari list ini --
// dipakai cuma di modal "Riwayat Harga" yang narik lewat GET /:id/history,
// tapi kalau ikut disini dia numpuk terus tiap kali harga diganti dan bikin
// payload /products (yang ditarik full di setiap load & buat cache offline)
// makin lama makin gendut. .lean() juga dipakai karena hasilnya cuma dibaca,
// gak perlu di-hydrate jadi Mongoose document.
router.get('/', async (req, res) => {
  try {
    const products = await Product.find()
      .select('-priceHistory -variants.priceHistory')
      .collation({ locale: 'id', strength: 2 }) // strength:2 = case-insensitive
      .sort({ name: 1 })
      .lean();
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/barcode/:code', async (req, res) => {
  try {
    const code = req.params.code;
    const codeVariants = barcodeVariants(code);
    const candidates = await Product.find({
      $or: [
        ...codeVariants.map(v => ({ barcode: { $regex: escapeRegex(v) } })),
        ...codeVariants.map(v => ({ 'variants.barcode': { $regex: escapeRegex(v) } }))
      ]
    })
      .select('-priceHistory -variants.priceHistory')
      .lean();
    for (const p of candidates) {
      if (hasBarcode(p, code)) return res.json(p);
      const matchedVariants = findAllVariantsByBarcode(p, code);
      if (matchedVariants.length > 1) {
        return res.json({ ...p, ambiguousVariant: true, matchedVariantIds: matchedVariants.map(v => String(v._id)) });
      }
      if (matchedVariants.length === 1) return res.json({ ...p, matchedVariantId: String(matchedVariants[0]._id) });
    }
    return res.status(404).json({ error: 'Barang dengan barcode ini tidak ditemukan' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload foto SELALU dobel: ImgBB (utama) + ImageKit (backup) sekaligus,
// dijalanin PARALEL (bukan berantai) biar gak nambah waktu tunggu 2x lipat.
// - Kalau ImgBB sukses -> itu yang jadi imageUrl utama; ImageKit (kalau
//   sukses juga) jadi imageUrlBackup.
// - Kalau ImgBB GAGAL (lagi down, dsb) tapi ImageKit sukses -> ImageKit
//   otomatis naik jadi imageUrl utama (failover), gak ada backup (cuma 1
//   sumber yang berhasil).
// - Kalau dua-duanya gagal -> baru dianggap gagal total & dibalikin error.
// Salah satu provider down TIDAK membatalkan upload selama yang satunya
// masih hidup -- itu tujuan utama fitur backup ini.
router.post('/upload-image', async (req, res) => {
  const requestStartedAt = Date.now();
  try {
    const { image } = req.body;
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ error: 'Data gambar wajib dikirim' });
    }
    if (image.length > 8_000_000) {
      return res.status(400).json({ error: 'Ukuran foto terlalu besar' });
    }

    const [imgbbResult, imagekitResult] = await Promise.allSettled([
      uploadToImgBB(image, requestStartedAt),
      uploadToImageKit(image, requestStartedAt)
    ]);

    if (imgbbResult.status === 'fulfilled') {
      const payload = { imageUrl: imgbbResult.value.imageUrl, source: 'imgbb', backupUrl: '', backupSource: '' };
      if (imagekitResult.status === 'fulfilled') {
        payload.backupUrl = imagekitResult.value.imageUrl;
        payload.backupSource = 'imagekit';
      }
      return res.json(payload);
    }

    if (imagekitResult.status === 'fulfilled') {
      // ImgBB gagal tapi ImageKit hidup -- failover otomatis, foto tetap
      // berhasil keupload (cuma gak ada "backup"-nya karena sumbernya
      // emang cuma 1 yang berhasil).
      return res.json({ imageUrl: imagekitResult.value.imageUrl, source: 'imagekit', backupUrl: '', backupSource: '' });
    }

    // Dua-duanya gagal.
    const imgbbErr = imgbbResult.reason;
    const imagekitErr = imagekitResult.reason;
    if (imgbbErr && imgbbErr.code === 'IMGBB_NOT_CONFIGURED' && imagekitErr && imagekitErr.code === 'IMAGEKIT_NOT_CONFIGURED') {
      return res.status(500).json({ error: 'Upload foto belum dikonfigurasi di server (IMGBB_API_KEY & IMAGEKIT_PRIVATE_KEY belum di-set)' });
    }
    res.status(502).json({ error: `Gagal upload foto. ImgBB: ${imgbbErr?.message || '-'}. ImageKit: ${imagekitErr?.message || '-'}.` });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Gagal upload foto' });
  }
});

// --- Migrasi foto lama (ImgBB-only) supaya juga punya backup ImageKit ---
// Dipanggil berulang-ulang dari frontend (loop), tiap panggilan cuma
// proses batch kecil biar gak kena timeout function. requireAdmin karena
// ini operasi bulk yang nyentuh banyak data sekaligus.
router.get('/migrate-images/status', requireAdmin, async (req, res) => {
  try {
    const status = await getMigrationStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/migrate-images/run', requireAdmin, async (req, res) => {
  const requestStartedAt = Date.now();
  try {
    const result = await runMigrationBatch(requestStartedAt);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Gagal menjalankan batch migrasi' });
  }
});

function sanitizeTiers(priceTiers) {
  if (!Array.isArray(priceTiers)) return [];
  const cleaned = priceTiers
    .map(t => ({
      qty: Math.floor(Number(t.qty) || 0),
      price: Number(t.price),
      label: String(t.label || '').trim(),
      featured: Boolean(t.featured)
    }))
    .filter(t => t.qty >= 2 && Number.isFinite(t.price) && t.price >= 0)
    .sort((a, b) => a.qty - b.qty);
  let alreadyFeatured = false;
  cleaned.forEach(t => {
    if (t.featured && alreadyFeatured) t.featured = false;
    else if (t.featured) alreadyFeatured = true;
  });
  return cleaned;
}

function sanitizeMinSaleQty(v) {
  return Math.max(1, Math.floor(Number(v) || 1));
}

// Expired date sengaja dibuat opsional (banyak barang kelontong bukan
// consumable/gak relevan) -- string kosong/invalid balik jadi null, bukan
// error, biar gak nge-block simpan barang yang emang gak diisi tanggalnya.
function sanitizeExpiredDate(v) {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function sanitizeVariants(variants) {
  if (!Array.isArray(variants)) return [];
  return variants
    .map(v => {
      const cleanVImageUrl = String(v.imageUrl || '').trim();
      return {
        _id: v._id || undefined, 
        name: String(v.name || '').trim(),
        unit: String(v.unit || '').trim(),
        price: Number(v.price),
        costPrice: Number(v.costPrice) || 0,
        stock: Math.max(0, Math.floor(Number(v.stock) || 0)),
        boxQty: Math.max(0, Math.floor(Number(v.boxQty) || 0)),
        minSaleQty: sanitizeMinSaleQty(v.minSaleQty),
        barcode: joinBarcodes(parseBarcodes(v.barcode)),
        priceTiers: sanitizeTiers(v.priceTiers),
        imageUrl: cleanVImageUrl,
        imageSource: cleanVImageUrl ? String(v.imageSource || 'manual').trim() : '',
        // imageUrlBackup cuma valid kalau ada imageUrl utama & sumbernya
        // ImageKit -- backup gak berarti apa-apa kalau foto utamanya sendiri
        // udah kosong/dihapus.
        imageUrlBackup: cleanVImageUrl ? String(v.imageUrlBackup || '').trim() : '',
        imageBackupSource: cleanVImageUrl && v.imageUrlBackup ? String(v.imageBackupSource || '').trim() : '',
        expiredDate: sanitizeExpiredDate(v.expiredDate)
      };
    })
    .filter(v => v.name && Number.isFinite(v.price) && v.price >= 0);
}

function allBarcodesOfDoc(p) {
  const codes = [...parseBarcodes(p.barcode)];
  (p.variants || []).forEach(v => codes.push(...parseBarcodes(v.barcode)));
  return codes;
}

async function findBarcodeConflict(codes, excludeId) {
  if (!codes.length) return null;
  const query = {
    $or: [{ barcode: { $ne: '' } }, { 'variants.barcode': { $ne: '' } }]
  };
  if (excludeId) query._id = { $ne: excludeId };
  const candidates = await Product.find(query, 'name barcode variants.barcode').lean();
  for (const p of candidates) {
    const existing = allBarcodesOfDoc(p);
    const clash = codes.find(c => barcodeVariants(c).some(v => existing.includes(v)));
    if (clash) return { code: clash, product: p };
  }
  return null;
}

function tiersChanged(newTiers, oldTiers) {
  const a = JSON.stringify((newTiers || []).map(t => ({ qty: t.qty, price: t.price, label: t.label, featured: t.featured })));
  const b = JSON.stringify((oldTiers || []).map(t => ({ qty: t.qty, price: t.price, label: t.label, featured: t.featured })));
  return a !== b;
}

router.post('/', validate(productSchema), async (req, res) => {
  try {
    const { name, category, subcategory, price, costPrice, stock, boxQty, minSaleQty, unit, barcode, priceTiers, variants, changedBy, imageUrl, imageSource, imageUrlBackup, imageBackupSource, expiredDate } = req.body;
    const cleanedVariants = sanitizeVariants(variants);
    const hasVariants = cleanedVariants.length > 0;

    const codes = hasVariants ? [] : parseBarcodes(barcode);
    const variantCodes = hasVariants ? cleanedVariants.flatMap(v => parseBarcodes(v.barcode)) : [];
    const badCode = findCorruptedBarcode([...codes, ...variantCodes]);
    if (badCode) {
      return res.status(400).json({ error: `Barcode "${badCode}" tidak valid (kemungkinan rusak jadi notasi ilmiah)` });
    }
    const conflict = await findBarcodeConflict([...codes, ...variantCodes], null);
    if (conflict) {
      return res.status(400).json({ error: `Barcode "${conflict.code}" sudah dipakai barang "${conflict.product.name}"` });
    }

    const cleanImageUrl = String(imageUrl || '').trim();
    const cleanImageSource = cleanImageUrl ? String(imageSource || 'manual').trim() : '';
    const cleanImageUrlBackup = cleanImageUrl ? String(imageUrlBackup || '').trim() : '';
    const cleanImageBackupSource = cleanImageUrl && cleanImageUrlBackup ? String(imageBackupSource || '').trim() : '';
    if (cleanImageUrl) {
      const imageError = validateImageUrl(cleanImageUrl);
      if (imageError) return res.status(400).json({ error: imageError });
    }
    for (const v of cleanedVariants) {
      if (v.imageUrl) {
        const vImageError = validateImageUrl(v.imageUrl);
        if (vImageError) return res.status(400).json({ error: `Foto varian "${v.name}": ${vImageError}` });
      }
    }

    let product;
    if (hasVariants) {
      product = await Product.create({
        name, category, subcategory: String(subcategory || '').trim(), unit,
        price: 0, costPrice: 0, stock: 0, boxQty: 0, minSaleQty: 1, barcode: '', priceTiers: [], priceHistory: [], expiredDate: null,
        imageUrl: cleanImageUrl, imageSource: cleanImageSource, imageUrlBackup: cleanImageUrlBackup, imageBackupSource: cleanImageBackupSource,
        variants: cleanedVariants.map(v => ({
          name: v.name, unit: v.unit, price: v.price, costPrice: v.costPrice, stock: v.stock, boxQty: v.boxQty, minSaleQty: v.minSaleQty, barcode: v.barcode, priceTiers: v.priceTiers,
          imageUrl: v.imageUrl, imageSource: v.imageSource, imageUrlBackup: v.imageUrlBackup, imageBackupSource: v.imageBackupSource, expiredDate: v.expiredDate,
          priceHistory: [{ price: v.price, costPrice: v.costPrice, priceTiers: v.priceTiers, changedBy: changedBy || '', changedAt: new Date() }]
        }))
      });
    } else {
      const cost = Number(costPrice) || 0;
      const cleanedTiers = sanitizeTiers(priceTiers);
      product = await Product.create({
        name, category, subcategory: String(subcategory || '').trim(), price, costPrice: cost, stock, boxQty: Math.max(0, Math.floor(Number(boxQty) || 0)), minSaleQty: sanitizeMinSaleQty(minSaleQty), unit,
        barcode: joinBarcodes(codes),
        priceTiers: cleanedTiers,
        expiredDate: sanitizeExpiredDate(expiredDate),
        imageUrl: cleanImageUrl, imageSource: cleanImageSource, imageUrlBackup: cleanImageUrlBackup, imageBackupSource: cleanImageBackupSource,
        priceHistory: [{ price: Number(price) || 0, costPrice: cost, priceTiers: cleanedTiers, changedBy: changedBy || '', changedAt: new Date() }]
      });
    }
    await logActivity(req, 'tambah_barang', product.name);
    res.status(201).json(product);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/bulk-import', requireAdmin, async (req, res) => {
  try {
    const { rows, changedBy } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'Tidak ada data yang diimpor' });
    }

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;
    const errors = [];
    const skips = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2; 
      try {
        const name = String(row.name || '').trim();
        const category = String(row.category || '').trim();
        const subcategory = String(row.subcategory || '').trim();
        const unit = String(row.unit || '').trim();
        const price = Number(row.price);
        const costPrice = Number(row.costPrice) || 0;
        const stock = Number(row.stock) || 0;

        if (!name) throw new Error('Nama barang kosong');
        if (!category) throw new Error('Kategori kosong');
        if (!unit) throw new Error('Satuan kosong');
        if (!Number.isFinite(price) || price < 0) throw new Error('Harga tidak valid');
        if (stock < 0) throw new Error('Stok tidak boleh minus');

        const codes = parseBarcodes(row.barcode || '');
        const badCode = findCorruptedBarcode(codes);
        if (badCode) {
          throw new Error(`Barcode "${badCode}" tidak valid (kemungkinan rusak jadi notasi ilmiah di Excel — format ulang kolom barcode sebagai Text lalu ketik ulang)`);
        }
        const conflict = await findBarcodeConflict(codes, null);

        let existing = null;
        if (codes.length > 0) {
          const candidates = await Product.find({ barcode: { $ne: '' } });
          existing = candidates.find(p => hasBarcode(p, codes[0])) || null;
        }
        if (!existing) {
          existing = await Product.findOne({
            name: new RegExp(`^${escapeRegex(name)}$`, 'i'),
            category: new RegExp(`^${escapeRegex(category)}$`, 'i')
          });
        }

        if (conflict && (!existing || String(existing._id) !== String(conflict.product._id))) {
          skipped++;
          skips.push({ row: rowNum, name, reason: `Barcode "${conflict.code}" sudah dipakai barang "${conflict.product.name}"` });
          continue;
        }

        if (existing && existing.variants && existing.variants.length > 0) {
          skipped++;
          skips.push({ row: rowNum, name, reason: `"${existing.name}" punya varian, dilewati (tidak bisa di-update lewat import massal)` });
          continue;
        }

        if (!existing && name.includes(' - ')) {
          const parentName = name.split(' - ')[0].trim();
          const parentCandidate = await Product.findOne({
            name: new RegExp(`^${escapeRegex(parentName)}$`, 'i'),
            category: new RegExp(`^${escapeRegex(category)}$`, 'i'),
            'variants.0': { $exists: true }
          });
          if (parentCandidate) {
            skipped++;
            skips.push({ row: rowNum, name, reason: `"${parentCandidate.name}" punya varian, dilewati (tidak bisa di-update lewat import massal)` });
            continue;
          }
        }

        if (existing) {
          const newBarcode = codes.length > 0 ? joinBarcodes(codes) : existing.barcode;
          const priceChanged = price !== existing.price;
          const costChanged = costPrice !== (existing.costPrice || 0);
          const anyFieldChanged =
            name !== existing.name ||
            category !== existing.category ||
            subcategory !== (existing.subcategory || '') ||
            priceChanged ||
            costChanged ||
            stock !== existing.stock ||
            unit !== existing.unit ||
            newBarcode !== (existing.barcode || '');

          if (!anyFieldChanged) {
            unchanged++;
            continue;
          }

          existing.name = name;
          existing.category = category;
          existing.subcategory = subcategory;
          existing.price = price;
          existing.costPrice = costPrice;
          existing.stock = stock;
          existing.unit = unit;
          existing.barcode = newBarcode;
          if (priceChanged || costChanged) {
            existing.priceHistory.push({ price, costPrice, changedBy: changedBy || 'Import', changedAt: new Date() });
          }
          await existing.save();
          updated++;
        } else {
          await Product.create({
            name, category, subcategory, price, costPrice, stock, unit,
            barcode: joinBarcodes(codes),
            priceHistory: [{ price, costPrice, changedBy: changedBy || 'Import', changedAt: new Date() }]
          });
          created++;
        }
      } catch (err) {
        errors.push({ row: rowNum, name: row.name || '', error: err.message });
      }
    }

    res.json({ created, updated, unchanged, skipped, errors, skips });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', validate(productSchema), async (req, res) => {
  try {
    const { name, category, subcategory, price, costPrice, stock, boxQty, minSaleQty, unit, barcode, priceTiers, variants, changedBy, imageUrl, imageSource, imageUrlBackup, imageBackupSource, expiredDate } = req.body;
    const existing = await Product.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Barang tidak ditemukan' });

    const before = { name: existing.name, price: existing.price, costPrice: existing.costPrice };

    const cleanedVariants = sanitizeVariants(variants);
    const hasVariants = cleanedVariants.length > 0;

    if (hasVariants) {
      for (const v of cleanedVariants) {
        if (v.imageUrl) {
          const vImageError = validateImageUrl(v.imageUrl);
          if (vImageError) return res.status(400).json({ error: `Foto varian "${v.name}": ${vImageError}` });
        }
      }
    }

    const codes = hasVariants ? [] : parseBarcodes(barcode);
    const variantCodes = hasVariants ? cleanedVariants.flatMap(v => parseBarcodes(v.barcode)) : [];
    const badCode = findCorruptedBarcode([...codes, ...variantCodes]);
    if (badCode) {
      return res.status(400).json({ error: `Barcode "${badCode}" tidak valid (kemungkinan rusak jadi notasi ilmiah)` });
    }
    const conflict = await findBarcodeConflict([...codes, ...variantCodes], req.params.id);
    if (conflict) {
      return res.status(400).json({ error: `Barcode "${conflict.code}" sudah dipakai barang "${conflict.product.name}"` });
    }

    existing.name = name;
    existing.category = category;
    existing.subcategory = String(subcategory || '').trim();
    existing.unit = unit;
    if (imageUrl !== undefined) {
      const nextImageUrl = String(imageUrl || '').trim();
      if (nextImageUrl) {
        const imageError = validateImageUrl(nextImageUrl);
        if (imageError) return res.status(400).json({ error: imageError });
      }
      existing.imageUrl = nextImageUrl;
      existing.imageSource = existing.imageUrl ? String(imageSource || 'manual').trim() : '';
      // Backup ImageKit cuma relevan kalau foto utama masih ada -- kalau
      // fotonya dihapus/diganti manual (bukan hasil dual-upload), backup
      // lama ikut dibuang juga biar gak nyimpen link yatim yang gak pernah
      // dipakai.
      const nextImageUrlBackup = existing.imageUrl ? String(imageUrlBackup || '').trim() : '';
      existing.imageUrlBackup = nextImageUrlBackup;
      existing.imageBackupSource = nextImageUrlBackup ? String(imageBackupSource || '').trim() : '';
    }

    if (hasVariants) {
      const oldById = new Map((existing.variants || []).map(v => [String(v._id), v]));
      // BUG FIX: sebelumnya gak ada penjagaan kalau _id yang dikirim client
      // ternyata KEMBAR di 2 baris varian berbeda dalam satu request yang
      // sama (mis. gara-gara state form yang nyangkut/race condition) --
      // keduanya bakal ke-assign `old._id` yang SAMA PERSIS, jadi 2
      // subdocument array punya _id identik. Efeknya: endpoint /stock yang
      // nyari lewat filter {'variants._id': variantId} + operator posisi
      // Mongo ($) cuma update elemen array PERTAMA yang cocok -- jadi
      // varian ke-2 (dst) yang _id-nya kembar itu gak akan PERNAH bisa
      // di-+/- stoknya sendiri, yang keupdate selalu varian pertama.
      // usedOldIds jaga supaya satu _id lama cuma boleh "dipakai ulang"
      // SEKALI per penyimpanan -- kalau ada _id yang udah kepake, baris
      // berikutnya yang ngaku _id itu dianggap varian BARU (biar Mongo
      // auto-generate _id unik buat dia), bukan numpang _id yang sama.
      // Ini juga otomatis "nyembuhin" data produk yang mungkin udah kadung
      // kembar dari sebelumnya begitu produk ini diedit & disimpan lagi.
      const usedOldIds = new Set();
      existing.variants = cleanedVariants.map(v => {
        let old = v._id ? oldById.get(String(v._id)) : null;
        if (old && usedOldIds.has(String(old._id))) old = null;
        if (old) usedOldIds.add(String(old._id));
        const priceChanged = !old || v.price !== old.price;
        const costChanged = !old || v.costPrice !== (old.costPrice || 0);
        const tiersDiff = tiersChanged(v.priceTiers, old ? old.priceTiers : []);
        const history = old ? [...old.priceHistory] : [];
        if (priceChanged || costChanged || tiersDiff) {
          history.push({ price: v.price, costPrice: v.costPrice, priceTiers: v.priceTiers, changedBy: changedBy || '', changedAt: new Date() });
        }
        const base = { name: v.name, unit: v.unit, price: v.price, costPrice: v.costPrice, stock: v.stock, boxQty: v.boxQty, minSaleQty: v.minSaleQty, barcode: v.barcode, priceTiers: v.priceTiers, imageUrl: v.imageUrl, imageSource: v.imageSource, imageUrlBackup: v.imageUrlBackup, imageBackupSource: v.imageBackupSource, expiredDate: v.expiredDate, priceHistory: history };
        if (old) base._id = old._id;
        return base;
      });
      existing.price = 0;
      existing.costPrice = 0;
      existing.stock = 0;
      existing.boxQty = 0;
      existing.minSaleQty = 1;
      existing.barcode = '';
      existing.priceTiers = [];
      existing.expiredDate = null;
    } else {
      const newPrice = Number(price) || 0;
      const newCost = Number(costPrice) || 0;
      const newTiers = sanitizeTiers(priceTiers);
      const priceChanged = newPrice !== existing.price;
      const costChanged = newCost !== (existing.costPrice || 0);
      const tiersDiff = tiersChanged(newTiers, existing.priceTiers);
      existing.price = newPrice;
      existing.costPrice = newCost;
      // stock wajib angka valid & gak minus -- request langsung ke API
      // (bukan lewat form utama di frontend, yang selalu ngirim stock)
      // yang kelewat kirim field ini dulu bakal diam-diam nge-unset
      // stock jadi undefined kalau di-assign apa adanya (Mongoose gak
      // otomatis balikin ke default 0 pas existing document di-save()
      // dengan field di-set undefined -- defaultnya cuma jalan pas
      // dokumen baru dibuat). Fallback ke stock lama kalau gak dikirim/
      // gak valid, biar gak ada jalan diam-diam ngilangin data stok.
      const parsedStock = Number(stock);
      existing.stock = Number.isFinite(parsedStock) ? Math.max(0, Math.floor(parsedStock)) : existing.stock;
      existing.boxQty = Math.max(0, Math.floor(Number(boxQty) || 0));
      existing.minSaleQty = sanitizeMinSaleQty(minSaleQty);
      existing.barcode = joinBarcodes(codes);
      existing.priceTiers = newTiers;
      existing.expiredDate = sanitizeExpiredDate(expiredDate);
      existing.variants = [];
      if (priceChanged || costChanged || tiersDiff) {
        existing.priceHistory.push({ price: newPrice, costPrice: newCost, priceTiers: newTiers, changedBy: changedBy || '', changedAt: new Date() });
      }
    }

    await existing.save();

    const changedFields = [];
    if (before.name !== existing.name) changedFields.push(`nama: "${before.name}" → "${existing.name}"`);
    if (before.price !== existing.price) changedFields.push(`harga: ${before.price} → ${existing.price}`);
    if (before.costPrice !== (existing.costPrice || 0)) changedFields.push(`harga modal: ${before.costPrice} → ${existing.costPrice}`);
    if (changedFields.length > 0) {
      await logActivity(req, 'ubah_barang', existing.name, changedFields.join(', '));
    }

    res.json(existing);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:id/history', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id, 'name priceHistory variants');
    if (!product) return res.status(404).json({ error: 'Barang tidak ditemukan' });
    const { variantId } = req.query;
    if (variantId) {
      const v = (product.variants || []).id(variantId);
      if (!v) return res.status(404).json({ error: 'Varian tidak ditemukan' });
      const history = [...(v.priceHistory || [])].sort((a, b) => new Date(b.changedAt) - new Date(a.changedAt));
      return res.json({ name: `${product.name} - ${v.name}`, history });
    }
    const history = [...(product.priceHistory || [])].sort((a, b) => new Date(b.changedAt) - new Date(a.changedAt));
    res.json({ name: product.name, history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Nambah/kurang stok manual dipakai kasir sehari-hari buat restock rutin
// (tombol +/- & tambah per dus di tabel Kelola Barang). Sekarang dicatat ke
// ActivityLog juga (action 'ubah_stok') biar kelihatan di Log Aktivitas,
// sama kayak stok opname -- cuma tanpa retry optimistic-lock karena ini
// murni delta atomic, jadi before/after diambil dari hasil $inc-nya langsung.
router.patch('/:id/stock', async (req, res) => {
  try {
    const { variantId } = req.body;
    const delta = Math.trunc(Number(req.body.delta));
    if (!Number.isFinite(delta) || delta === 0) {
      return res.status(400).json({ error: 'Jumlah perubahan stok tidak valid' });
    }

    // Atomic $inc dengan guard "stock cukup" di filter (sama pola dengan
    // decrement stok pas checkout) -- bukan lagi baca-ubah-simpan, biar gak
    // ada lost update kalau 2 kasir/device pencet +/- barang yang sama
    // hampir bersamaan. Kalau delta positif, guard-nya otomatis lolos
    // (nambah stok gak pernah bikin minus).
    // BUG FIX (akar masalah "pencet + di varian A, yang nambah malah varian
    // B"): dulu filter-nya nulis 'variants._id' dan 'variants.stock' sebagai
    // 2 kondisi TERPISAH yang sama-sama nunjuk ke path array `variants`,
    // tanpa $elemMatch. MongoDB gak jamin operator posisi `$` di update
    // bakal ngerujuk ke elemen array yang lolos KEDUA kondisi itu SEKALIGUS
    // -- dia bisa aja kepilih elemen array lain yang kebetulan juga lolos
    // guard stock (`{$gte: -delta}`, yang lolos buat semua stok non-negatif
    // kalau delta-nya positif alias lagi nambah stok), meski _id-nya beda
    // dari variantId yang diminta. $elemMatch di sini maksa kedua kondisi
    // itu harus match di ELEMEN ARRAY YANG SAMA, jadi `$` gak ambigu lagi.
    let updated;
    if (variantId) {
      updated = await Product.findOneAndUpdate(
        { _id: req.params.id, variants: { $elemMatch: { _id: variantId, stock: { $gte: -delta } } } },
        { $inc: { 'variants.$.stock': delta } },
        { new: true }
      );
    } else {
      updated = await Product.findOneAndUpdate(
        { _id: req.params.id, stock: { $gte: -delta } },
        { $inc: { stock: delta } },
        { new: true }
      );
    }

    if (!updated) {
      // Gagal bisa karena produk/varian gak ketemu, ATAU guard stock gagal
      // (delta negatif lebih besar dari stok yang ada) -- dibedain di sini
      // biar pesan errornya tetap akurat.
      const exists = await Product.findById(req.params.id);
      if (!exists) return res.status(404).json({ error: 'Barang tidak ditemukan' });
      if (variantId && !exists.variants.id(variantId)) {
        return res.status(404).json({ error: 'Varian tidak ditemukan' });
      }
      return res.status(400).json({ error: 'Stok tidak boleh minus' });
    }

    let label, before, after;
    if (variantId) {
      const v = updated.variants.id(variantId);
      label = `${updated.name} - ${v.name}`;
      after = v.stock;
    } else {
      label = updated.name;
      after = updated.stock;
    }
    before = after - delta;
    await logActivity(
      req,
      'ubah_stok',
      label,
      `${delta > 0 ? '+' : ''}${delta} (${before} → ${after})`
    );

    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Opname nyetel stok ke angka ABSOLUT hasil hitung fisik (bukan delta),
// jadi gak bisa dibikin atomic pakai $inc doang kayak endpoint /stock di
// atas. Dipakai optimistic concurrency: baca stock "before", lalu update
// HANYA kalau stock di DB masih persis sama dengan yang barusan dibaca
// (filter menyertakan nilai before). Kalau gagal (ada request lain yang
// keduluan ubah stock barang ini di antara baca & simpan), retry max 2x
// baca ulang -- biar before/selisih yang tercatat di ActivityLog selalu
// akurat, gak ada lost update kalau 2 device opname/checkout bersamaan.
async function applyOpname(productId, variantId, actual) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const product = await Product.findById(productId);
    if (!product) return { error: 'NOT_FOUND' };

    let before, label;
    if (variantId) {
      const v = product.variants.id(variantId);
      if (!v) return { error: 'VARIANT_NOT_FOUND' };
      before = v.stock;
      label = `${product.name} - ${v.name}`;
    } else {
      before = product.stock;
      label = product.name;
    }

    // BUG FIX: sama kayak endpoint /stock di atas -- 'variants._id' dan
    // 'variants.stock' harus digabung via $elemMatch, bukan jadi 2 kondisi
    // terpisah di path array yang sama, biar operator posisi `$` gak salah
    // pilih elemen varian yang di-update.
    const filter = variantId
      ? { _id: productId, variants: { $elemMatch: { _id: variantId, stock: before } } }
      : { _id: productId, stock: before };
    const update = variantId
      ? { $set: { 'variants.$.stock': actual } }
      : { $set: { stock: actual } };

    const updated = await Product.findOneAndUpdate(filter, update, { new: true });
    if (updated) {
      return { product: updated, before, after: actual, selisih: actual - before, label };
    }
    // Keduluan update lain -- ulangi dari baca lagi (nilai `before` yang
    // dipakai buat filter di attempt berikutnya otomatis jadi yang terbaru).
  }
  return { error: 'CONFLICT' };
}

router.patch('/:id/opname', async (req, res) => {
  try {
    const { actualStock, variantId, note } = req.body;
    const actual = Math.floor(Number(actualStock));
    if (!Number.isFinite(actual) || actual < 0) {
      return res.status(400).json({ error: 'Jumlah stok fisik tidak valid' });
    }

    const result = await applyOpname(req.params.id, variantId, actual);
    if (result.error === 'NOT_FOUND') return res.status(404).json({ error: 'Barang tidak ditemukan' });
    if (result.error === 'VARIANT_NOT_FOUND') return res.status(404).json({ error: 'Varian tidak ditemukan' });
    if (result.error === 'CONFLICT') {
      return res.status(409).json({ error: 'Stok barang ini baru saja berubah dari device lain, coba opname ulang.' });
    }

    const { product, before, after, selisih, label } = result;
    await logActivity(
      req,
      'stok_opname',
      label,
      `Sistem: ${before} → Fisik: ${after} (selisih ${selisih >= 0 ? '+' : ''}${selisih})${note ? ' - ' + note : ''}`
    );

    res.json({ product, before, after, selisih });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ error: 'Barang tidak ditemukan' });
    await logActivity(req, 'hapus_barang', product.name);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function findImportDuplicates() {
  const all = await Product.find({}, 'name category variants.name').lean();
  const variantParents = all.filter(p => p.variants && p.variants.length > 0);
  const dupes = [];
  for (const p of all) {
    if (p.variants && p.variants.length > 0) continue;
    if (!p.name.includes(' - ')) continue;
    const parentName = p.name.split(' - ')[0].trim().toLowerCase();
    const parent = variantParents.find(vp => vp.name.trim().toLowerCase() === parentName && vp.category === p.category);
    if (parent) dupes.push({ _id: p._id, name: p.name, category: p.category, parentName: parent.name });
  }
  return dupes;
}

router.get('/import-duplicates', requireAdmin, async (req, res) => {
  try {
    const dupes = await findImportDuplicates();
    res.json(dupes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/import-duplicates/delete', requireAdmin, async (req, res) => {
  try {
    const dupes = await findImportDuplicates();
    if (dupes.length > 0) {
      await Product.deleteMany({ _id: { $in: dupes.map(d => d._id) } });
    }
    res.json({ deleted: dupes.length, names: dupes.map(d => d.name) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ringkasan kategori & subkategori dipakai halaman "Kelola Kategori" di
// Pengaturan -- daripada nge-scroll+dedup 400an produk di frontend, biar
// MongoDB yang ngitung distinct category/subcategory + jumlah barangnya.
router.get('/categories/summary', async (req, res) => {
  try {
    const rows = await Product.aggregate([
      { $group: { _id: { category: '$category', subcategory: '$subcategory' }, count: { $sum: 1 } } },
      { $sort: { '_id.category': 1, '_id.subcategory': 1 } }
    ]).collation({ locale: 'id', strength: 2 });

    const byCategory = {};
    for (const row of rows) {
      const cat = row._id.category;
      const sub = row._id.subcategory || '';
      if (!byCategory[cat]) byCategory[cat] = { category: cat, count: 0, subcategories: [] };
      byCategory[cat].count += row.count;
      if (sub) byCategory[cat].subcategories.push({ subcategory: sub, count: row.count });
    }
    res.json(Object.values(byCategory));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rename kategori (semua produk di kategori itu) ATAU rename subkategori
// spesifik (kalau field `subcategory` diisi, scope-nya cuma ke produk yang
// category+subcategory-nya persis cocok). Kalau nama barunya kebetulan sama
// kayak kategori/subkategori yang udah ada, ini otomatis jadi "gabung" dua
// kategori jadi satu -- gak perlu endpoint terpisah buat merge.
router.put('/categories/rename', requireAdmin, async (req, res) => {
  try {
    const category = String(req.body.category || '').trim();
    const newCategory = String(req.body.newCategory || '').trim();
    const subcategory = String(req.body.subcategory || '').trim();
    const newSubcategory = String(req.body.newSubcategory || '').trim();

    if (!category) return res.status(400).json({ error: 'Kategori asal wajib diisi' });

    let filter, update, scopeLabel;
    if (subcategory) {
      // Scope ke subkategori spesifik -- kategori induknya boleh ikut
      // dipindah sekalian (misal pindahin subkategori ke kategori lain).
      if (!newCategory && !newSubcategory) {
        return res.status(400).json({ error: 'Isi nama kategori atau subkategori baru' });
      }
      filter = { category, subcategory };
      update = {};
      if (newCategory) update.category = newCategory;
      if (newSubcategory) update.subcategory = newSubcategory;
      scopeLabel = `${category} > ${subcategory}`;
    } else {
      if (!newCategory) return res.status(400).json({ error: 'Nama kategori baru wajib diisi' });
      filter = { category };
      update = { category: newCategory };
      scopeLabel = category;
    }

    const result = await Product.updateMany(filter, { $set: update });
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Gak ada produk yang cocok dengan kategori/subkategori itu' });
    }

    await logActivity(req, 'rename_kategori', scopeLabel, `${result.modifiedCount} produk diperbarui`);
    res.json({ matched: result.matchedCount, modified: result.modifiedCount });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
