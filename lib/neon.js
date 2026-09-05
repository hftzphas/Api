// Backup KEDUA (selain Telegram) buat seluruh database -- disimpan di Neon
// Postgres, format snapshot JSON yang PERSIS sama kayak /backup/export dan
// isi backup Telegram. Bedanya: ini kesimpen di database yang bisa langsung
// di-query balik lewat kode (tombol "Restore dari Cloud" di halaman
// Pengaturan), gak perlu download-upload file manual kayak backup Telegram.
//
// Sengaja pakai driver '@neondatabase/serverless' (HTTP-based, bukan TCP
// pool kayak node-postgres biasa) -- cocok buat serverless function Vercel
// yang connection-nya pendek-pendek dan sering cold start.
const { neon } = require('@neondatabase/serverless');
const { sendTelegramNotif } = require('./telegram');

const ALERT_COOLDOWN_MS = 15 * 60 * 1000;
let lastAlertAt = 0;
function alertNeonFailure(reason) {
  const now = Date.now();
  if (now - lastAlertAt < ALERT_COOLDOWN_MS) return;
  lastAlertAt = now;
  sendTelegramNotif(`🚨 <b>Backup cloud (Neon) gagal</b>\n${reason}\n\nCek NEON_DATABASE_URL & status project Neon.`);
}

function getSql() {
  if (!process.env.NEON_DATABASE_URL) {
    throw new Error('NEON_DATABASE_URL belum di-set di environment server');
  }
  return neon(process.env.NEON_DATABASE_URL);
}

// IF NOT EXISTS -- aman dipanggil berkali-kali, jadi gak perlu migration
// terpisah. Dipanggil di awal tiap operasi (save/list/get) biar tabelnya
// otomatis ada bahkan di percobaan pertama tanpa setup manual.
async function ensureTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS kasir_backups (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      counts JSONB NOT NULL,
      data JSONB NOT NULL
    )
  `;
}

// Simpan snapshot, lalu buang snapshot lama di luar KEEP terbaru -- Neon free
// tier storage terbatas (0.5GB), dan snapshot lama gak ada gunanya kalau yang
// baru udah ada (beda kasus sama backup Telegram yang sengaja diarsipin di
// chat sebagai riwayat, bukan buat restore cepat).
const KEEP_SNAPSHOTS = 8;

async function saveSnapshot(snapshot) {
  try {
    const sql = getSql();
    await ensureTable(sql);
    await sql`
      INSERT INTO kasir_backups (counts, data)
      VALUES (${JSON.stringify(snapshot.counts)}::jsonb, ${JSON.stringify(snapshot.data)}::jsonb)
    `;
    await sql`
      DELETE FROM kasir_backups
      WHERE id NOT IN (
        SELECT id FROM kasir_backups ORDER BY created_at DESC LIMIT ${KEEP_SNAPSHOTS}
      )
    `;
  } catch (err) {
    alertNeonFailure(err.message);
    throw err;
  }
}

async function listSnapshots() {
  const sql = getSql();
  await ensureTable(sql);
  const rows = await sql`
    SELECT id, created_at, counts FROM kasir_backups ORDER BY created_at DESC LIMIT ${KEEP_SNAPSHOTS}
  `;
  return rows;
}

async function getSnapshotData(id) {
  const sql = getSql();
  await ensureTable(sql);
  const rows = await sql`SELECT data FROM kasir_backups WHERE id = ${id} LIMIT 1`;
  if (rows.length === 0) return null;
  return rows[0].data;
}

module.exports = { saveSnapshot, listSnapshots, getSnapshotData };
