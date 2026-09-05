const { z } = require('zod');

// Angka yang kadang dikirim sebagai string dari form/CSV import (mis. "15000").
// z.coerce.number() nerima keduanya tapi tetap nolak non-angka beneran (mis. "abc").
// Catatan Zod 4: invalid_type_error/required_error udah dihapus, diganti satu
// param "error" yang menangani semua kasus (termasuk tipe salah & field kosong).
const numeric = () => z.coerce.number({ error: 'harus berupa angka' });

const registerSchema = z.object({
  username: z.string().trim().min(3, 'minimal 3 karakter').max(50, 'maksimal 50 karakter'),
  password: z.string().min(6, 'minimal 6 karakter').max(100),
  name: z.string().trim().min(1, 'wajib diisi').max(100),
  role: z.enum(['admin', 'kasir']).optional()
}).passthrough();

const loginSchema = z.object({
  username: z.string().trim().min(1, 'wajib diisi'),
  password: z.string().min(1, 'wajib diisi'),
  deviceLabel: z.string().trim().max(80).optional(),
  deviceId: z.string().trim().max(100).optional()
}).passthrough();

const initSchema = z.object({
  username: z.string().trim().min(3, 'minimal 3 karakter').max(50),
  password: z.string().min(6, 'minimal 6 karakter').max(100),
  name: z.string().trim().min(1, 'wajib diisi').max(100)
}).passthrough();

// name/category/unit selalu wajib baik pas produk single maupun punya varian
// (lihat routes/products.js POST & PUT) -- harga/stok/dll divalidasi lebih
// detail di sanitizeVariants()/sanitizeTiers() yang tetap jalan sesudah ini.
const productSchema = z.object({
  name: z.string().trim().min(1, 'wajib diisi').max(150),
  category: z.string().trim().min(1, 'wajib diisi').max(80),
  unit: z.string().trim().min(1, 'wajib diisi').max(30),
  price: numeric().min(0, 'tidak boleh minus').optional(),
  costPrice: numeric().min(0, 'tidak boleh minus').optional(),
  stock: numeric().min(0, 'tidak boleh minus').optional(),
  variants: z.array(z.record(z.string(), z.any())).optional()
}).passthrough();

const customerSchema = z.object({
  name: z.string().trim().min(1, 'wajib diisi').max(100),
  phone: z.string().trim().max(30).optional()
}).passthrough();

// Item dicek longgar (cuma qty wajib angka) karena bentuknya beda-beda
// tergantung manual/produk biasa/varian -- pengecekan detail (harga > 0,
// stok cukup, dll) tetap dilakukan di routes/transactions.js sendiri.
const transactionSchema = z.object({
  items: z.array(z.record(z.string(), z.any()))
    .min(1, 'keranjang tidak boleh kosong')
    .max(100, 'Maksimal 100 item per transaksi'),
  paymentMethod: z.string().trim().min(1).max(60).optional(),
  paid: numeric().optional(),
  customerName: z.string().trim().max(100).optional()
}).passthrough();

module.exports = { registerSchema, loginSchema, initSchema, productSchema, customerSchema, transactionSchema };
