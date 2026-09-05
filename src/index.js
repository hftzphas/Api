import { ApiDurableObject } from './ApiDurableObject.js';
export { ApiDurableObject };

// Semua request (dan cron di bawah) diarahin ke 1 instance DO yang sama --
// "singleton" cuma nama sembarang, konsisten dipakai supaya idFromName
// selalu ngembaliin ID yang sama.
function getStub(env) {
  const id = env.API_DO.idFromName('singleton');
  return env.API_DO.get(id);
}

// Peta jadwal cron -> endpoint lama yang mau dipanggil. Jadwalnya sendiri
// didaftarin di wrangler.jsonc ("triggers.crons"), disamain persis sama
// server/vercel.json yang asli (Sabtu 17:00 UTC buat 2 backup, tiap hari
// 17:00 UTC buat cek expired).
const CRON_ROUTES = {
  '0 17 * * 6': ['/cron/backup-telegram', '/cron/backup-neon'],
  '0 17 * * *': ['/cron/expiry-check']
};

export default {
  async fetch(request, env) {
    return getStub(env).fetch(request);
  },

  async scheduled(event, env, ctx) {
    const paths = CRON_ROUTES[event.cron] || [];
    const stub = getStub(env);
    for (const path of paths) {
      // scheduled() cuma bisa dipicu Cloudflare sendiri (gak reachable dari
      // luar kayak endpoint HTTP biasa), tapi endpoint /cron/* di app.js
      // tetap ngecek header Authorization: Bearer CRON_SECRET seperti
      // aslinya -- jadi tetep kita kirim biar konsisten & gampang di-tes
      // manual juga (curl pake secret yang sama).
      const req = new Request(`https://internal.local${path}`, {
        headers: { authorization: `Bearer ${env.CRON_SECRET}` }
      });
      ctx.waitUntil(stub.fetch(req));
    }
  }
};
