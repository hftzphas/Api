const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');

const connectDB = require('./lib/db');
const productRoutes = require('./routes/products');
const transactionRoutes = require('./routes/transactions');
const User = require('./models/User');
const authRoutes = require('./routes/authRoutes');
const reportRoutes = require('./routes/reportsRoutes');
const customerRoutes = require('./routes/customers');
const backupRoutes = require('./routes/backup');
const settingRoutes = require('./routes/settings');
const activityRoutes = require('./routes/activity');
const telegramBroadcastRoutes = require('./routes/telegramBroadcast');
const notificationRoutes = require('./routes/notificationsRoutes');
const { requireAuth, requireAdmin } = require('./lib/authLib');
const { authLimiter, apiLimiter } = require('./lib/rateLimit');
const { validate } = require('./lib/validate');
const { initSchema } = require('./lib/schemas');
const { sendTelegramNotif } = require('./lib/telegram');
const { performExpiryCheck } = require('./lib/expiryCheck');

const app = express();

// Perlu supaya express-rate-limit membaca IP asli client (bukan IP proxy
// internal Vercel) lewat header X-Forwarded-For.
app.set('trust proxy', 1);

// Header keamanan dasar (nosniff, hilangin X-Powered-By, dll). CSP dimatiin
// karena ini API JSON + satu halaman status HTML kecil (statusPageHtml di
// bawah) yang pakai inline <style> tanpa nonce -- CSP default helmet bakal
// mblokir itu. Kalau nanti ada halaman HTML lain yang lebih serius, CSP-nya
// bisa dinyalain lagi dengan whitelist yang sesuai.
app.use(helmet({ contentSecurityPolicy: false }));

const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (allowedOrigins.length === 0) {
  throw new Error('CORS_ORIGIN wajib diset (daftar origin frontend, pisah koma).');
}

app.use(cors({
  origin: allowedOrigins
}));
// Gzip semua response JSON -- payload seperti /products (list barang + histori
// harga sebelumnya) bisa berkurang drastis ukurannya di jaringan lambat.
app.use(compression());
app.use(express.json({ limit: '2mb' }));

// Rate limit umum buat SEMUA endpoint (lihat lib/rateLimit.js) -- lapisan
// tambahan di atas authLimiter yang cuma jagain /auth. Dipasang di sini,
// sebelum requireAuth, supaya berlaku juga buat request yang tokennya udah
// gak valid (bukan cuma yang lolos auth).
app.use(apiLimiter);

// Dulu tiap route didaftarin 2x, sekali dengan prefix /api/... sekali tanpa
// (mis. app.use('/api/products', ...) DAN app.use('/products', ...)) -- padahal
// frontend cuma pernah manggil yang tanpa prefix. Sekarang tiap route cuma
// didefinisikan SEKALI (tanpa prefix /api), dan middleware ini yang
// nge-alias /api/* -> /* di level request, biar URL lama (kalau ada yang
// masih nyimpen/bookmark /api/...) tetap jalan tanpa perlu didaftarin dobel.
app.use((req, res, next) => {
  if (req.url === '/api' || req.url.startsWith('/api/')) {
    req.url = req.url.slice(4) || '/';
  }
  next();
});

app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error('Gagal konek MongoDB:', err.message);
    res.status(500).json({ error: 'Gagal menghubungkan ke database' });
  }
});

// dbStats di-cache 60 detik -- perintah ini emang ringan (cuma baca metadata
// ukuran koleksi/index dari storage engine, gak scan data), tapi tetap ada
// 1 round-trip ke Atlas. Endpoint '/' ini sering dipanggil bolak-balik sama
// uptime monitor, jadi di-cache biar gak nambah query ke Mongo tiap ping.
const DB_STATS_TTL_MS = 60 * 1000;
let cachedDbStats = null;
let cachedDbStatsAt = 0;

async function getDbStats() {
  const now = Date.now();
  if (cachedDbStats && (now - cachedDbStatsAt) < DB_STATS_TTL_MS) return cachedDbStats;
  try {
    // scale: 1024*1024 -- field ukuran (dataSize/storageSize/indexSize) dari
    // Mongo langsung dibagi jadi satuan MB, gak perlu itung manual di sini.
    const stats = await mongoose.connection.db.command({ dbStats: 1, scale: 1024 * 1024 });
    cachedDbStats = {
      collections: stats.collections,
      objects: stats.objects,
      dataSizeMB: Math.round(stats.dataSize * 100) / 100,
      storageSizeMB: Math.round(stats.storageSize * 100) / 100,
      indexSizeMB: Math.round(stats.indexSize * 100) / 100,
      totalSizeMB: Math.round((stats.storageSize + stats.indexSize) * 100) / 100
    };
    cachedDbStatsAt = now;
  } catch (err) {
    console.error('Gagal ambil statistik MongoDB:', err.message);
    // Gagal ambil yang baru -- tetap balikin cache lama (kalau ada) daripada
    // bikin seluruh halaman status ikut error gara-gara statistik doang.
  }
  return cachedDbStats;
}

// Favicon emoji 📃 di-inline langsung sebagai data URI SVG -- gak perlu file
// .ico/.png terpisah yang harus di-precache/di-serve manual.
const FAVICON = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">📃</text></svg>'
);

const statusPayload = { status: 'ok', message: 'API Kasir H&K berjalan' };
// Halaman ini cuma buat status check '/' (dan '/api', yang di-alias ke '/'
// oleh middleware di atas) -- endpoint sepi yang biasa dibuka manual di
// browser atau dipanggil uptime monitor. Gak nyentuh endpoint sibuk
// (products/transactions/dll), jadi gak nambah beban ke API beneran. Kalau
// yang manggil nerima JSON (curl, monitoring tool, fetch() tanpa header
// khusus), tetep dibales JSON biar gak ada yang kebreak.
function renderStatusPageHtml(dbStats) {
  const statsHtml = dbStats ? `
    <div class="stats">
      <div class="stat"><span>Storage terpakai</span><b>${dbStats.storageSizeMB} MB</b></div>
      <div class="stat"><span>Data</span><b>${dbStats.dataSizeMB} MB</b></div>
      <div class="stat"><span>Index</span><b>${dbStats.indexSizeMB} MB</b></div>
      <div class="stat"><span>Koleksi</span><b>${dbStats.collections}</b></div>
      <div class="stat"><span>Dokumen</span><b>${dbStats.objects.toLocaleString('id-ID')}</b></div>
    </div>` : '';
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="description" content="Status API Kasir H&amp;K - endpoint backend untuk aplikasi kasir.">
<title>API Kasir H&amp;K</title>
<link rel="icon" href="${FAVICON}">
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#1b4332;color:#f5f1e8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}
  .card{text-align:center;padding:32px;}
  .dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#5fd68a;
    box-shadow:0 0 10px #5fd68a;margin-right:8px;}
  h1{font-size:20px;margin:0 0 8px;font-weight:700;}
  p{margin:0;opacity:0.75;font-size:14px;}
  code{background:rgba(255,255,255,0.1);padding:2px 6px;border-radius:4px;font-size:12px;}
  .stats{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;margin-top:20px;}
  .stat{background:rgba(255,255,255,0.08);border-radius:8px;padding:10px 14px;min-width:90px;}
  .stat span{display:block;font-size:11px;opacity:0.8;margin-bottom:4px;}
  .stat b{font-size:15px;}
</style>
</head>
<body>
  <main class="card">
    <h1><span class="dot"></span>API Kasir H&amp;K</h1>
    <p>Api berjalan normal.</p>
    ${statsHtml}
  </main>
</body>
</html>`;
}

async function statusResponse(req, res){
  const dbStats = await getDbStats();
  if ((req.headers.accept || '').includes('text/html')) {
    return res.type('html').send(renderStatusPageHtml(dbStats));
  }
  res.json(dbStats ? { ...statusPayload, dbStats } : statusPayload);
}

app.get('/', statusResponse);

// llms.txt -- rekomendasi buat agen/LLM crawler: file Markdown dengan
// minimal satu header H1, isinya ringkasan singkat API ini.
app.get('/llms.txt', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.type('text/markdown').send(
`# API Kasir H&K

Backend REST API untuk aplikasi kasir (POS). Menyediakan endpoint autentikasi,
produk, transaksi, laporan, pelanggan, backup, pengaturan, dan log aktivitas.
Butuh autentikasi (token) untuk sebagian besar endpoint.

## Endpoint

- [Status API](${base}/)
- [Autentikasi](${base}/auth)
- [Produk](${base}/products)
- [Transaksi](${base}/transactions)
- [Laporan](${base}/reports)
- [Pelanggan](${base}/customers)
`);
});

async function handleAuthInit(req, res) {
  try {
    const requiredSecret = process.env.INIT_SECRET;
    if (!requiredSecret) {
      // Kalau INIT_SECRET gak diset, endpoint ini WAJIB nolak -- bukan
      // lewatin validasi. Sebelumnya kosong = siapapun bisa bikin admin
      // pertama tanpa secret sama sekali.
      return res.status(503).json({ error: 'Setup awal dinonaktifkan (INIT_SECRET belum diset di server)' });
    }
    if (req.body.secret !== requiredSecret) {
      return res.status(401).json({ error: 'INIT_SECRET salah atau belum dikirim' });
    }
    const existingAdmin = await User.findOne({ role: 'admin' });
    if (existingAdmin) {
      return res.status(400).json({ error: 'Admin sudah ada' });
    }
    const { username, password, name } = req.body;
    const passwordHash = await require('bcryptjs').hash(password, 10);
    const admin = await User.create({
      username: username.toLowerCase(),
      passwordHash,
      name,
      role: 'admin'
    });
    res.json({ success: true, message: 'Admin berhasil dibuat', user: { username: admin.username, name: admin.name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
app.post('/auth/init', authLimiter, validate(initSchema), handleAuthInit);

// Dipicu Vercel Cron (lihat vercel.json), BUKAN dari frontend -- jadi
// otentikasinya beda dari sisa API: bukan JWT login admin, tapi header
// Authorization: Bearer <CRON_SECRET> yang otomatis disisipin Vercel kalau
// env var CRON_SECRET di-set di project settings. Sengaja dipasang di sini,
// SEBELUM middleware x-api-key & requireAuth di bawah, supaya cron gak perlu
// (dan gak bisa) lewat otentikasi yang ditujukan buat request dari frontend.
app.get('/cron/backup-telegram', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return res.status(500).json({ error: 'CRON_SECRET belum di-set di environment server' });
  }
  const header = req.header('authorization') || '';
  if (header !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await backupRoutes.performTelegramBackup(Date.now(), true);
    res.json({ success: true, counts: result.counts });
  } catch (err) {
    // Backup mingguan gagal itu sendiri udah cukup penting buat dikabarin --
    // beda dari upload foto yang emang dirate-limit, di sini kirim tiap gagal
    // aja (paling banter 1x seminggu, gak bakal nge-spam).
    await sendTelegramNotif(`🚨 <b>Backup mingguan otomatis GAGAL</b>\n${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Cron backup cloud (Neon) -- otentikasi sama persis kayak cron backup
// Telegram di atas. Sengaja dipisah jadi endpoint & cron entry sendiri
// (bukan digabung ke /cron/backup-telegram) supaya jadwal/on-off-nya bisa
// diatur independen tanpa ganggu backup Telegram yang udah jalan.
app.get('/cron/backup-neon', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return res.status(500).json({ error: 'CRON_SECRET belum di-set di environment server' });
  }
  const header = req.header('authorization') || '';
  if (header !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await backupRoutes.performNeonBackup(true);
    res.json({ success: true, counts: result.counts });
  } catch (err) {
    await sendTelegramNotif(`🚨 <b>Backup cloud (Neon) otomatis GAGAL</b>\n${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Cron harian -- cek barang yang mendekati/udah expired & kirim 1 notif
// Telegram gabungan (lihat lib/expiryCheck.js). Otentikasi sama persis kayak
// cron backup di atas (CRON_SECRET, bukan JWT admin).
app.get('/cron/expiry-check', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return res.status(500).json({ error: 'CRON_SECRET belum di-set di environment server' });
  }
  const header = req.header('authorization') || '';
  if (header !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await performExpiryCheck();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use((req, res, next) => {
  const requiredKey = process.env.API_KEY;
  if (!requiredKey) return next();
  const providedKey = req.header('x-api-key');
  if (providedKey !== requiredKey) {
    return res.status(401).json({ error: 'API key tidak valid' });
  }
  next();
});

app.use('/auth', authRoutes);
app.use('/products', requireAuth, productRoutes);
app.use('/transactions', requireAuth, transactionRoutes);
app.use('/reports', requireAuth, reportRoutes);
app.use('/customers', requireAuth, customerRoutes);
app.use('/backup', requireAuth, backupRoutes);
app.use('/settings', settingRoutes);
app.use('/activity', requireAuth, requireAdmin, activityRoutes);
app.use('/telegram', telegramBroadcastRoutes);
app.use('/notifications', requireAuth, notificationRoutes);

// CATATAN PORTING KE CLOUDFLARE WORKERS:
// File ini adalah salinan dari server/api/index.js (project Vercel asli),
// cuma beda 2 hal:
//   1. Path require di atas (../lib -> ./lib, dst) -- karena file ini
//      sekarang ada di root repo, bukan di dalam folder api/.
//   2. Blok `if (require.main === module) { app.listen(...) }` di bawah
//      ini DIHAPUS -- itu cuma buat `node api/index.js` pas dev lokal di
//      Vercel. Di Workers, app.listen() dan pembungkusan httpServerHandler
//      dilakukan di src/ApiDurableObject.js, BUKAN di sini, supaya app
//      Express ini bisa "dipasang" di dalam Durable Object (buat jaga
//      koneksi Mongoose tetap kepake ulang, bukan connect baru tiap
//      request -- lihat penjelasan di README.md).
// Selebihnya (semua route, middleware, endpoint cron, dll di atas)
// PERSIS SAMA kayak versi Vercel -- gak ada logic bisnis yang diubah.
module.exports = app;
