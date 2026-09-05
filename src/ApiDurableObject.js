import { DurableObject } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';

// KENAPA APP EXPRESS-NYA HARUS "TINGGAL" DI DALAM DURABLE OBJECT, BUKAN DI
// index.js LANGSUNG:
//
// Worker biasa (non-DO) bisa dijalanin di BANYAK isolate paralel sekaligus
// kalau lagi rame -- masing-masing isolate punya `global`-nya sendiri.
// Kalau app Express (dan koneksi Mongoose di lib/db.js yang nyimpen di
// `global._mongooseConn`) ada di situ, tiap isolate baru = koneksi Mongo
// baru ke Atlas, bisa numpuk banyak koneksi bersamaan & boros connection
// pool Atlas -- ini salah satu akar masalah percobaan CF sebelumnya.
//
// Durable Object dijamin CUMA ADA 1 instance untuk 1 nama/ID tertentu di
// seluruh jaringan Cloudflare, dan request ke situ diproses satu-satu
// (bukan paralel). Jadi app Express + koneksi Mongoose-nya beneran cuma
// ada SATU, dan ke-reuse terus selama instance ini masih hidup.
export class ApiDurableObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.handler = null;
    this.bootPromise = null;
  }

  async ensureServer() {
    if (this.handler) return this.handler;
    if (!this.bootPromise) this.bootPromise = this.bootstrap();
    await this.bootPromise;
    return this.handler;
  }

  async bootstrap() {
    // PENTING soal urutan: app.js (dan lib/authLib.js di dalamnya) baca
    // process.env.JWT_SECRET dkk LANGSUNG pas file-nya di-load (bukan pas
    // ada request masuk) -- authLib.js bahkan sengaja `throw` kalau
    // JWT_SECRET belum ada. Makanya binding/secret Workers (this.env) WAJIB
    // disalin ke process.env DULU, baru app.js di-import pakai dynamic
    // import(). Dynamic import (beda dari `import` statis di atas) baru
    // benar-benar jalan pas baris ini dieksekusi -- bukan langsung pas file
    // ini di-load -- jadi urutannya kejamin: env dulu, baru app.
    Object.assign(process.env, this.env);

    const appModule = await import('../app.js');
    const app = appModule.default || appModule;

    // Port ini gak beneran "buka port" ke jaringan luar -- cuma dipakai
    // internal sama httpServerHandler buat nyambungin Request Workers ke
    // instance Express ini. Bebas angka berapa aja asal gak bentrok sama
    // yang lain di isolate yang sama (di sini cuma ada 1, jadi aman).
    const PORT = 5000;
    app.listen(PORT);
    this.handler = httpServerHandler({ port: PORT });
  }

  async fetch(request) {
    const handler = await this.ensureServer();
    return handler.fetch(request, this.env);
  }
}
