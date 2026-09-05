# api-kasir-cf-test

Ini **porting penuh** `api-kasir-main` ke Cloudflare Workers -- bukan
mock/toy test kayak sebelumnya. Semua `routes/`, `models/`, `lib/` di sini
adalah **salinan verbatim** (isi persis sama, gak ada baris logic yang
diubah) dari repo `api-kasir-main` lu. Yang beda cuma cara "nyalain"
Express-nya (`app.js` + `src/`), karena Workers butuh cara boot yang beda
dari Vercel.

**Ini bukan pengganti `api-kasir-main`.** Repo terpisah, deploy ke Worker
terpisah (`api-kasir-cf-test`), pakai database MongoDB terpisah buat tes.
Kalau gagal, tinggal dibuang -- production di Vercel gak kesenggol sama
sekali.

## Apa yang beda dari `api-kasir-main`

| File | Status |
|---|---|
| `routes/*.js` | **Sama persis**, copy-paste |
| `models/*.js` | **Sama persis**, copy-paste |
| `lib/*.js` | **Sama persis**, copy-paste |
| `app.js` (dulu `api/index.js`) | Sama persis, cuma path require disesuaikan (`../lib` → `./lib`) dan blok `app.listen()` buat dev lokal Vercel dihapus |
| `src/ApiDurableObject.js` | **BARU** -- nyalain Express app di atas lewat `httpServerHandler`, dipasang di dalam Durable Object |
| `src/index.js` | **BARU** -- entry point Worker, forward semua request+cron ke Durable Object |
| `wrangler.jsonc` | **BARU** -- konfigurasi Cloudflare (ganti punya `vercel.json`) |

## Kenapa arsitekturnya begini (Durable Object)

Baca komentar di `src/ApiDurableObject.js`, tapi intinya: Worker biasa bisa
jalan di banyak isolate paralel sekaligus kalau lagi rame, dan tiap
isolate = koneksi Mongo baru + rate-limiter baru (`express-rate-limit`
nyimpen hitungannya di memory). Durable Object jamin cuma ada SATU instance
yang megang app Express + koneksi Mongoose + rate limiter, jadi semuanya
beneran ke-reuse, sama seperti waktu jalan di 1 proses Node biasa/Vercel.

## Yang JUJUR belum ke-verifikasi

Gw susun ini dari dokumentasi resmi Cloudflare (`httpServerHandler`,
`node:net`/`node:tls` support) dan pola yang dipakai komunitas buat
Mongoose+workerd. **Tapi belum pernah gw jalanin beneran** -- gw gak punya
akses jaringan buat `npm install`/`wrangler dev` dari sini. Yang gw
pastiin: semua file valid secara sintaks JS/JSON.

Bagian yang paling belum pasti (belum ada contoh publik yang persis sama):
- **`httpServerHandler` dipanggil dari DALAM Durable Object**, bukan
  sebagai top-level default export Worker seperti di semua contoh resmi
  Cloudflare. Secara desain harusnya bisa (dia cuma butuh dipanggil abis
  `app.listen()`, hasilnya objek dengan method `.fetch()`), tapi ini
  kombinasi yang belum pernah gw liat didokumentasikan resmi.
- **`adm-zip`** (dipakai di `routes/backup.js`) kemungkinan besar `require('fs')`
  di dalemnya walau gak dipakai buat fitur backup ini (yang cuma bikin zip
  di memory) -- dengan `nodejs_compat`, `fs` itu stub sebagian, biasanya
  gak masalah kalau cuma di-import tapi metodenya gak dipanggil, tapi ini
  perlu dibuktiin, bukan diasumsikan.
- **`web-push`** (VAPID) belum gw cek detail kompatibilitasnya dengan
  workerd -- kemungkinan besar aman (cuma HTTP request + crypto), tapi
  belum diverifikasi.

Kalau salah satu ini gagal pas dites, itu bukan berarti keseluruhan
pendekatan mubazir -- biasanya cuma butuh 1 keputusan kecil (mis. ganti
`adm-zip` ke library zip pure-JS lain kalau beneran bermasalah).

## Cara testing

Butuh terminal (`npm` + `wrangler`).

### 1. Install
```
npm install
```
Perhatiin log `[patch-mongoose] OK ...` muncul.

### 2. Siapkan environment
```
cp .dev.vars.example .dev.vars
```
Isi `.dev.vars` -- **pakai nilai yang SAMA** kayak env var di Vercel
project `api-kasir-main` lu sekarang untuk semuanya KECUALI:
- `MONGODB_URI` -- wajib ganti ke database/nama-db TES, jangan production.
- `CRON_SECRET` -- boleh bikin baru khusus tes.

### 3. Jalanin lokal
```
npm run dev
```

### 4. Tes endpoint dasar (gak butuh login)
```
curl http://localhost:8787/
curl http://localhost:8787/llms.txt
```
Kalau `/` balikin JSON `{"status":"ok",...}` dengan `dbStats` ke-isi,
artinya koneksi Mongoose ke Atlas BENERAN JALAN.

### 5. Tes login (buat ngetes auth + JWT_SECRET + rate limiter beneran hidup)
```
curl -X POST http://localhost:8787/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"...","password":"..."}'
```
Pakai akun yang udah ada (kalau database tes-nya kosong/beda dari
production, mungkin perlu `/auth/init` dulu dengan `INIT_SECRET`).

### 6. Tes koneksi ke-reuse
Panggil `/` beberapa kali (5-10x) berturut-turut, perhatiin `dbStats`
di-cache 60 detik (lihat komentar di `app.js`) jadi buat ngetes reuse
koneksi murni, lebih jelas liat lewat endpoint yang query per-request
(mis. `/products` abis login).

### 7. Tes cron manual
```
curl http://localhost:8787/cron/expiry-check -H "Authorization: Bearer <CRON_SECRET-yang-diisi-di-.dev.vars>"
```

### 8. Kalau lokal lancar, baru deploy beneran
```
wrangler login
wrangler secret bulk .dev.vars   # atau satu-satu pakai `wrangler secret put NAMA`
npm run deploy
```
Lalu ulangi tes di atas ganti `localhost:8787` jadi URL
`*.workers.dev` yang dikasih.

## Kalau ada yang gagal

Kabarin ke gw: pesan error persis + di step mana gagalnya (install /
dev lokal / deploy / request tertentu). Dari situ baru kita diagnosa akar
masalahnya, bukan asal ganti-ganti.
