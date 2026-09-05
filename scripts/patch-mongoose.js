// Cloudflare Workers (workerd) resolve import module beda caranya sama
// Node biasa -- dia baca field "exports" di package.json. Mongoose belum
// selalu nyantumin kondisi "workerd" di exports-nya, jadi tanpa patch ini
// workerd bisa ke-resolve ke build BROWSER Mongoose (yang gak punya akses
// TCP asli) -- akibatnya koneksi ke MongoDB gagal, kadang gak ada
// pesan error yang jelas.
//
// Script ini jalan otomatis abis `npm install` (lihat "postinstall" di
// package.json), jadi gak perlu diinget-inget buat edit manual tiap kali
// reinstall/update mongoose.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const pkgPath = path.join(process.cwd(), 'node_modules', 'mongoose', 'package.json');

if (!existsSync(pkgPath)) {
  console.log('[patch-mongoose] mongoose belum ketemu di node_modules, skip (cek npm install-nya berhasil apa nggak).');
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

if (pkg.exports && pkg.exports['.'] && pkg.exports['.'].workerd) {
  console.log('[patch-mongoose] sudah ke-patch sebelumnya, skip.');
  process.exit(0);
}

const existingBrowser = (pkg.exports && pkg.exports['.'] && pkg.exports['.'].browser) || './dist/browser.umd.js';

pkg.exports = {
  '.': {
    workerd: './index.js',
    node: './index.js',
    browser: existingBrowser,
    types: './types/index.d.ts',
    default: './index.js'
  }
};

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
console.log('[patch-mongoose] OK -- field "exports" ditambahin, workerd sekarang bakal pake build Node, bukan browser bundle.');
