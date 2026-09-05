const mongoose = require('mongoose');

const historyEntrySchema = new mongoose.Schema({
  type: { type: String, enum: ['utang', 'bayar'], required: true },
  amount: { type: Number, required: true },
  note: { type: String, default: '' },
  // Internal marker so a checkout that fails after updating customer debt can
  // roll back exactly its own history entry without touching another entry.
  checkoutMarker: { type: String, default: '' },
  date: { type: Date, default: Date.now }
}, { _id: false });

const customerSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  phone: { type: String, trim: true, default: '' },
  balance: { type: Number, default: 0 }, 
  history: [historyEntrySchema]
}, { timestamps: true });

// unique + collation case-insensitive (bukan strength default) biar konsisten
// sama cara GET /customers nyortir ('id', strength 2) dan sama cara route
// POST di bawah nyari existing customer -- "Budi" dan "budi" dianggap
// pelanggan yang SAMA, sesuai perilaku yang sudah ada sebelumnya (bukan
// perilaku baru). unique index bikin ini atomic di level DB, bukan cuma
// dicek di memory sebelum create (rawan race kalau dua request bareng).
//
// CATATAN DEPLOY: kalau di DB sekarang udah ada 2 customer dengan nama
// sama (varian huruf besar/kecil), pembuatan index ini bakal GAGAL sampai
// data itu digabung/dihapus manual dulu.
customerSchema.index(
  { name: 1 },
  { unique: true, collation: { locale: 'id', strength: 2 } }
);

module.exports = mongoose.models.Customer || mongoose.model('Customer', customerSchema);
