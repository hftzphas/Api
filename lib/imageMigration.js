// Migrasi foto lama (yang cuma ada di ImgBB) supaya juga punya backup di
// ImageKit -- dipanggil berkali-kali secara batch dari routes/products.js
// (endpoint /migrate-images/run), bukan sekali jalan borongan semua, biar
// gak kena timeout function Vercel (30 detik) kalau barangnya banyak.
// Progressnya "stateless" (dihitung ulang dari data produk tiap kali, bukan
// disimpan terpisah) -- jadi kalau macet di tengah (koneksi putus, dsb)
// tinggal dipanggil lagi dari sisa yang belum, gak perlu direset.
//
// PENTING: item dalam 1 batch diproses PARALEL (Promise.allSettled), bukan
// satu-satu berurutan. Versi awal proses berurutan cuma sanggup ~2 foto per
// panggilan supaya gak lewat batas 30 detik, padahal tiap foto banyakan
// nunggu jaringan (download dari ImgBB, upload ke ImageKit) -- waktu itu
// harusnya bisa numpuk bareng, bukan ditotal. Paralel = throughput jauh
// lebih tinggi dalam budget waktu yang sama.
const Product = require('../models/Product');
const { uploadBufferToImageKitOnce, fetchImageAsBuffer } = require('./imagekit');

// Jumlah foto yang dicoba SEKALIGUS (paralel) tiap panggilan. Worst-case tiap
// item butuh ~8s download + ~9s upload = ~17s kalau lambat -- karena jalan
// bareng, total waktu batch ~ waktu item PALING LAMA, bukan jumlah semuanya.
// 10 item paralel dengan timeout segitu masih nyisain margin dari batas 30
// detik function Vercel.
const BATCH_SIZE = 10;
const DOWNLOAD_TIMEOUT_MS = 8000;
const UPLOAD_TIMEOUT_MS = 9000;
const REQUEST_DEADLINE_MS = 30000;
const DEADLINE_SAFETY_MS = 4000;

function isPending(entry) {
  return entry && entry.imageUrl && entry.imageSource === 'imgbb' && entry.imageBackupSource !== 'imagekit';
}

// Query filter Mongo buat kandidat dokumen yang MUNGKIN punya minimal 1 foto
// pending (produk utama atau salah satu variannya) -- dipakai buat narrow
// down sebelum diproses di JS (variant itu array, gak praktis difilter
// presisi di level query Mongo).
const CANDIDATE_FILTER = {
  $or: [
    { imageSource: 'imgbb', imageBackupSource: { $ne: 'imagekit' } },
    { variants: { $elemMatch: { imageSource: 'imgbb', imageBackupSource: { $ne: 'imagekit' } } } }
  ]
};

// Status ringkas: total foto yang pernah dari ImgBB, berapa yang udah punya
// backup ImageKit, sisanya. Dihitung pakai aggregation (bukan narik semua
// dokumen ke Node) biar tetap murah walau jumlah barang banyak.
async function getMigrationStatus() {
  const [row] = await Product.aggregate([
    {
      $project: {
        mainTotal: { $cond: [{ $eq: ['$imageSource', 'imgbb'] }, 1, 0] },
        mainMigrated: { $cond: [{ $and: [{ $eq: ['$imageSource', 'imgbb'] }, { $eq: ['$imageBackupSource', 'imagekit'] }] }, 1, 0] },
        variantTotal: {
          $size: { $filter: { input: { $ifNull: ['$variants', []] }, as: 'v', cond: { $eq: ['$$v.imageSource', 'imgbb'] } } }
        },
        variantMigrated: {
          $size: {
            $filter: {
              input: { $ifNull: ['$variants', []] },
              as: 'v',
              cond: { $and: [{ $eq: ['$$v.imageSource', 'imgbb'] }, { $eq: ['$$v.imageBackupSource', 'imagekit'] }] }
            }
          }
        }
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: { $add: ['$mainTotal', '$variantTotal'] } },
        migrated: { $sum: { $add: ['$mainMigrated', '$variantMigrated'] } }
      }
    }
  ]);
  const total = row ? row.total : 0;
  const migrated = row ? row.migrated : 0;
  return { total, migrated, remaining: Math.max(0, total - migrated), isComplete: total > 0 ? migrated >= total : true };
}

// Satu unit kerja migrasi: download dari ImgBB + upload ke ImageKit, lalu
// tempel hasilnya ke field yang sesuai (produk utama atau varian tertentu).
// `applyResult` yang nentuin field mana yang diisi -- biar fungsi ini generik
// buat kedua kasus (produk & varian), gak perlu ditulis 2x.
async function migrateOneImage(task) {
  try {
    const { buffer, mime, ext } = await fetchImageAsBuffer(task.imageUrl, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
    const result = await uploadBufferToImageKitOnce(buffer, { timeoutMs: UPLOAD_TIMEOUT_MS, tags: 'migrated', mime, ext });
    task.applyResult(result.imageUrl);
    return { ok: true, task };
  } catch (err) {
    return { ok: false, task, reason: err.message || 'Gagal migrasi' };
  }
}

// Kumpulin daftar tugas (foto pending) dari kandidat dokumen, sampai
// mentok BATCH_SIZE. 1 dokumen bisa nyumbang lebih dari 1 tugas (foto utama
// + beberapa varian sekaligus).
function collectTasks(candidates, limit) {
  const tasks = [];
  for (const doc of candidates) {
    if (tasks.length >= limit) break;
    if (isPending(doc)) {
      tasks.push({
        imageUrl: doc.imageUrl,
        label: doc.name,
        productId: String(doc._id),
        doc,
        applyResult(url) { doc.imageUrlBackup = url; doc.imageBackupSource = 'imagekit'; }
      });
      if (tasks.length >= limit) break;
    }
    for (const v of (doc.variants || [])) {
      if (tasks.length >= limit) break;
      if (!isPending(v)) continue;
      tasks.push({
        imageUrl: v.imageUrl,
        label: `${doc.name} (varian: ${v.name})`,
        productId: String(doc._id),
        doc,
        applyResult(url) { v.imageUrlBackup = url; v.imageBackupSource = 'imagekit'; }
      });
    }
  }
  return tasks;
}

// Proses 1 batch. Selalu berhenti dengan aman (gak pernah throw ke
// pemanggil) -- item yang gagal cuma dicatat di `failed` & tetap "pending"
// buat dicoba lagi di panggilan berikutnya, jadi satu foto rusak/link mati
// gak bikin seluruh migrasi macet.
async function runMigrationBatch(requestStartedAt = Date.now()) {
  const candidates = await Product.find(CANDIDATE_FILTER).limit(60);
  const tasks = collectTasks(candidates, BATCH_SIZE);

  let migrated = 0;
  const failed = [];

  if (tasks.length > 0) {
    const remainingBudget = (requestStartedAt + REQUEST_DEADLINE_MS) - Date.now() - DEADLINE_SAFETY_MS;
    // Kalau sisa waktu function udah mepet (mis. query kandidat di atas
    // somehow lambat), mending gak mulai batch baru sama sekali daripada
    // mulai lalu keputus paksa oleh Vercel di tengah upload (yang bisa
    // ninggalin foto ke-upload ke ImageKit tapi gak sempat kesimpen ke DB).
    if (remainingBudget >= DOWNLOAD_TIMEOUT_MS + UPLOAD_TIMEOUT_MS) {
      const settled = await Promise.allSettled(tasks.map(migrateOneImage));
      const changedDocs = new Map();
      for (const s of settled) {
        const r = s.value; // migrateOneImage gak pernah reject, selalu resolve {ok,...}
        if (r.ok) {
          migrated++;
          changedDocs.set(r.task.productId, r.task.doc);
        } else {
          failed.push({ productId: r.task.productId, name: r.task.label, reason: r.reason });
        }
      }
      // Simpen tiap dokumen SEKALI aja walau ada beberapa foto (varian) yang
      // berubah di dokumen yang sama dalam batch ini.
      await Promise.all([...changedDocs.values()].map(doc => doc.save()));
    }
  }

  const status = await getMigrationStatus();
  return { processed: tasks.length, migrated, failed, ...status };
}

module.exports = { getMigrationStatus, runMigrationBatch };
