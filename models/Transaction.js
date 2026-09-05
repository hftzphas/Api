const mongoose = require('mongoose');

const returnItemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  variantId: { type: String, default: '' }, 
  name: String,
  qty: Number, 
  amount: Number 
}, { _id: false });

const returnSchema = new mongoose.Schema({
  items: [returnItemSchema],
  amount: { type: Number, default: 0 }, 
  reason: { type: String, default: '' },
  returnedBy: { type: String, default: '' },
  returnedAt: { type: Date, default: Date.now }
}, { _id: false });

const itemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  variantId: { type: String, default: '' }, 
  name: String,
  category: { type: String, default: '' },
  subcategory: { type: String, default: '' },
  price: Number, 
  costPrice: { type: Number, default: 0 }, 
  qty: Number, 
  subtotal: Number, 
  // Subtotal item SETELAH alokasi proporsional diskon transaksi. Dipakai
  // buat hitung nominal refund retur yang benar -- kalau dipakai subtotal
  // mentah (sebelum diskon), retur bisa ngembaliin lebih dari yang
  // sebenarnya dibayar pelanggan. Default null: transaksi LAMA (dibuat
  // sebelum field ini ada) gak punya nilai ini -- handler retur fallback
  // ke subtotal mentah kalau null (perilaku lama, cuma salah kalau memang
  // ada diskon transaksi).
  netSubtotal: { type: Number, default: null },
  unit: String,
  priceNote: { type: String, default: '' }, 
  returnedQty: { type: Number, default: 0 } 
}, { _id: false });

const transactionSchema = new mongoose.Schema({
  clientTxId: { type: String, unique: true, sparse: true },
  items: [itemSchema],
  subtotal: { type: Number, default: 0 }, 
  discount: { type: Number, default: 0 }, 
  total: { type: Number, required: true }, 
  paid: { type: Number, required: true },
  change: { type: Number, required: true },
  cashier: { type: String, default: '' },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
  customerName: { type: String },
  debtAmount: { type: Number, default: 0 },
  paymentMethod: { type: String, default: 'tunai' },
  payments: {
    type: [{
      method: { type: String, enum: ['tunai', 'qris'], required: true },
      amount: { type: Number, required: true, min: 0 }
    }],
    default: []
  },
  status: { type: String, enum: ['selesai', 'void'], default: 'selesai' },
  voidedAt: { type: Date },
  voidedBy: { type: String, default: '' },
  voidReason: { type: String, default: '' },
  returns: { type: [returnSchema], default: [] },
  returnedAmount: { type: Number, default: 0 }, 
  debtRefunded: { type: Number, default: 0 } 
}, { timestamps: true });

// Query laporan & riwayat selalu filter/sort berdasarkan createdAt, dan
// laporan juga hampir selalu exclude status void -- compound index ini
// mempercepat kedua pola query itu sekaligus.
transactionSchema.index({ createdAt: -1, status: 1 });

module.exports = mongoose.models.Transaction || mongoose.model('Transaction', transactionSchema);
