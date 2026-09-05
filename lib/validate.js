// Middleware tipis buat validasi req.body pake skema Zod (lib/schemas.js).
// Sengaja "shape-level" (cek field wajib ada, tipe bener, enum valid), BUKAN
// pengganti logic bisnis yang udah ada di tiap route (sanitizeVariants,
// cek konflik barcode, dll) -- itu tetap jalan setelah lolos sini. Tujuannya
// nangkep kesalahan input paling dasar (field kosong, angka minus, tipe
// salah) di satu tempat yang konsisten, sebelum request masuk ke logic yang
// lebih ribet.
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const first = result.error.issues[0];
      const field = first.path.length ? first.path.join('.') : 'input';
      return res.status(400).json({ error: `${field}: ${first.message}` });
    }
    // .passthrough() di skema udah mastiin field lain (yang gak divalidasi
    // eksplisit) tetap ikut, jadi aman di-assign balik ke req.body.
    req.body = result.data;
    next();
  };
}

module.exports = { validate };
