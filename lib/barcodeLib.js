function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseBarcodes(barcode) {
  return String(barcode || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function isCorruptedBarcode(code) {
  const c = String(code || '');
  return /[eE][+-]\d/.test(c) || /^\d+\.\d+$/.test(c);
}

function findCorruptedBarcode(codes) {
  return (codes || []).find(isCorruptedBarcode) || null;
}

function joinBarcodes(codes) {
  return [...new Set((codes || []).map(s => String(s).trim()).filter(Boolean))].join(',');
}

function barcodeVariants(code) {
  const c = String(code || '').trim();
  const variants = [c];
  if (/^0\d{12}$/.test(c)) variants.push(c.slice(1)); 
  else if (/^\d{12}$/.test(c)) variants.push('0' + c); 
  return variants;
}

function hasBarcode(product, code) {
  const list = parseBarcodes(product.barcode);
  return barcodeVariants(code).some(v => list.includes(v));
}

function findVariantByBarcode(product, code) {
  const variants = product.variants || [];
  for (const v of variants) {
    const list = parseBarcodes(v.barcode);
    if (barcodeVariants(code).some(c => list.includes(c))) return v;
  }
  return null;
}

function findAllVariantsByBarcode(product, code) {
  const variants = product.variants || [];
  const codeVariants = barcodeVariants(code);
  return variants.filter(v => {
    const list = parseBarcodes(v.barcode);
    return codeVariants.some(c => list.includes(c));
  });
}

module.exports = { escapeRegex, parseBarcodes, joinBarcodes, hasBarcode, barcodeVariants, findVariantByBarcode, findAllVariantsByBarcode, findCorruptedBarcode };
