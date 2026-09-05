const Product = require('../models/Product');
const Setting = require('../models/Setting');
const { sendTelegramNotif, escapeHtmlForTelegram: esc } = require('./telegram');
const { notifyEvent } = require('./notify');

const DEFAULT_WARNING_DAYS = 7;

// Sama kayak di reports.js: server (Vercel) jalan di UTC, tapi "hari ini"
// buat itung H- expired harus ngikutin WIB, gak boleh ngikutin jam server.
// WIB gak kenal DST jadi offset +7 aman dihardcode.
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

// Ambil field Y/M/D "hari ini" versi WIB, dari instant UTC manapun (default
// sekarang) -- geser +7 jam lalu baca getUTC*, itu jadi merepresentasikan
// tanggal kalender WIB tanpa perlu library timezone.
function wibDateParts(instant = new Date()) {
  const shifted = new Date(instant.getTime() + WIB_OFFSET_MS);
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth(), d: shifted.getUTCDate() };
}

function daysUntil(date) {
  const exp = new Date(date);
  if (Number.isNaN(exp.getTime())) return null;
  const today = wibDateParts();
  const startToday = Date.UTC(today.y, today.m, today.d);
  // Tanggal expired disimpen sebagai tanggal polos "YYYY-MM-DD" dari frontend,
  // yang di-parse Mongoose/JS sebagai UTC 00:00 tanggal itu (sama kayak yang
  // dijelasin di reports.js soal parseWibDateBoundary) -- makanya field Y/M/D
  // yang bener buat dibaca adalah getUTC*, BUKAN getFullYear/getMonth/getDate
  // versi lokal (yang kebetulan sama kalau server-nya UTC, tapi salah kalau
  // server pindah TZ lain suatu saat).
  const startExp = Date.UTC(exp.getUTCFullYear(), exp.getUTCMonth(), exp.getUTCDate());
  return Math.round((startExp - startToday) / 86400000);
}

// Dipicu sekali sehari lewat /cron/expiry-check (lihat vercel.json + api/index.js).
// Ngecek SEMUA barang (produk biasa & tiap varian) yang expiredDate-nya jatuh
// dalam N hari ke depan (N = setting expiry_warning_days, default 7) ATAU
// yang udah lewat tanggal expired tapi datanya belum diberesin -- lalu kirim
// SATU notif Telegram gabungan (bukan per-barang) biar chat gak kebanjiran.
//
// CATATAN: ini cek polos harian, gak nyimpen histori "udah pernah dikabarin
// belum" -- jadi barang yang sama bakal nongol lagi di notif besoknya selama
// masih dalam window peringatan/masih expired & belum di-update (restok
// dengan tanggal baru, atau dihapus). Sengaja dibikin simpel gini (gak nambah
// koleksi/state baru cuma buat dedup notif); efeknya toko dapet notif tiap
// hari, bukan sekali doang, sampai datanya dibereskan.
async function performExpiryCheck() {
  const notifSetting = await Setting.findOne({ key: 'notif_barang_expired' }).lean();
  if (notifSetting && notifSetting.value === 'off') {
    return { skipped: true, reason: 'notif_barang_expired dimatikan' };
  }

  const warningSetting = await Setting.findOne({ key: 'expiry_warning_days' }).lean();
  const parsedWarning = warningSetting && warningSetting.value ? Math.floor(Number(warningSetting.value)) : NaN;
  const warningDays = Number.isFinite(parsedWarning) && parsedWarning > 0 ? parsedWarning : DEFAULT_WARNING_DAYS;

  const products = await Product.find({
    $or: [
      { expiredDate: { $ne: null } },
      { 'variants.expiredDate': { $ne: null } }
    ]
  }, 'name expiredDate variants.name variants.expiredDate').lean();

  const expiredLines = [];
  const expiringLines = [];

  for (const p of products) {
    const entries = (p.variants && p.variants.length > 0)
      ? p.variants.filter(v => v.expiredDate).map(v => ({ label: `${esc(p.name)} - ${esc(v.name)}`, date: v.expiredDate }))
      : (p.expiredDate ? [{ label: esc(p.name), date: p.expiredDate }] : []);

    for (const entry of entries) {
      const days = daysUntil(entry.date);
      if (days === null) continue;
      const dateLabel = new Date(entry.date).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
      if (days < 0) {
        expiredLines.push(`• ${entry.label} — expired ${dateLabel} (${Math.abs(days)} hari lalu)`);
      } else if (days <= warningDays) {
        expiringLines.push(`• ${entry.label} — expired ${dateLabel} (${days === 0 ? 'HARI INI' : `${days} hari lagi`})`);
      }
    }
  }

  if (expiredLines.length === 0 && expiringLines.length === 0) {
    return { sent: false, expiredCount: 0, expiringCount: 0 };
  }

  const sections = [];
  if (expiredLines.length > 0) {
    sections.push(`🚨 <b>SUDAH EXPIRED</b>\n\n${expiredLines.join('\n')}`);
  }
  if (expiringLines.length > 0) {
    sections.push(`⏰ <b>MENDEKATI EXPIRED (≤ ${warningDays} hari)</b>\n\n${expiringLines.join('\n')}`);
  }
  await sendTelegramNotif(sections.join('\n\n'));
  notifyEvent({
    type: 'barang_expired',
    title: expiredLines.length > 0 ? 'Barang Expired' : 'Barang Mendekati Expired',
    message: [...expiredLines, ...expiringLines].map(l => l.replace(/^• /, '')).join(', ')
  }).catch(() => {});
  return { sent: true, expiredCount: expiredLines.length, expiringCount: expiringLines.length };
}

module.exports = { performExpiryCheck };
