const mongoose = require('mongoose');

const priceTierSchema = new mongoose.Schema({
  qty: { type: Number, required: true, min: 2 },
  price: { type: Number, required: true, min: 0 },
  label: { type: String, trim: true, default: '' },
  featured: { type: Boolean, default: false }
}, { _id: false });

const priceHistorySchema = new mongoose.Schema({
  price: { type: Number, required: true },
  costPrice: { type: Number, default: 0 },
  priceTiers: { type: [priceTierSchema], default: [] },
  changedBy: { type: String, trim: true, default: '' },
  changedAt: { type: Date, default: Date.now }
}, { _id: false });

const variantSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true }, 
  unit: { type: String, trim: true, default: '' },
  price: { type: Number, required: true, min: 0 },
  costPrice: { type: Number, min: 0, default: 0 },
  priceTiers: { type: [priceTierSchema], default: [] },
  stock: { type: Number, required: true, min: 0, default: 0 },
  boxQty: { type: Number, min: 0, default: 0 },
  minSaleQty: { type: Number, min: 1, default: 1 },
  barcode: { type: String, trim: true, default: '' },
  priceHistory: { type: [priceHistorySchema], default: [] },
  imageUrl: { type: String, trim: true, default: '' },
  imageSource: { type: String, trim: true, default: '' },
  // Backup foto di ImageKit -- diisi otomatis pas upload (dual-upload ke
  // ImgBB + ImageKit sekaligus) atau lewat migrasi manual di Pengaturan.
  // Kalau imageUrl (ImgBB) mati/broken, frontend fallback ke sini.
  imageUrlBackup: { type: String, trim: true, default: '' },
  imageBackupSource: { type: String, trim: true, default: '' },
  expiredDate: { type: Date, default: null }
});

const productSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  category: { type: String, required: true, trim: true },
  subcategory: { type: String, trim: true, default: '' },
  price: { type: Number, min: 0, default: 0 }, 
  costPrice: { type: Number, min: 0, default: 0 }, 
  priceTiers: { type: [priceTierSchema], default: [] }, 
  stock: { type: Number, min: 0, default: 0 }, 
  boxQty: { type: Number, min: 0, default: 0 },
  minSaleQty: { type: Number, min: 1, default: 1 },
  unit: { type: String, required: true, trim: true }, 
  barcode: { type: String, trim: true, default: '' },
  priceHistory: { type: [priceHistorySchema], default: [] },
  variants: { type: [variantSchema], default: [] },
  imageUrl: { type: String, trim: true, default: '' },
  imageSource: { type: String, trim: true, default: '' },
  imageUrlBackup: { type: String, trim: true, default: '' },
  imageBackupSource: { type: String, trim: true, default: '' },
  expiredDate: { type: Date, default: null }
}, { timestamps: true });

productSchema.index({ name: 1 });
productSchema.index({ category: 1 });
productSchema.index({ barcode: 1 });
productSchema.index({ 'variants.barcode': 1 });
productSchema.index({ expiredDate: 1 });
productSchema.index({ 'variants.expiredDate': 1 });
// Buat query migrasi ImageKit (lib/imageMigration.js) -- tanpa ini, makin
// sedikit sisa foto yang pending, makin lambat query-nya nyari sisanya di
// antara ratusan dokumen yang udah selesai (harus "nyisir" satu-satu tanpa
// index). Kejadian nyata: migrasi 644 foto awalnya cepat, tapi ngelambat
// drastis begitu sisa tinggal ~250-an -- ini fix-nya.
productSchema.index({ imageSource: 1, imageBackupSource: 1 });
productSchema.index({ 'variants.imageSource': 1, 'variants.imageBackupSource': 1 });

module.exports = mongoose.models.Product || mongoose.model('Product', productSchema);
