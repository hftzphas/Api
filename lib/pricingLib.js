function calcLinePrice(product, qty) {
  qty = Math.max(0, Math.floor(Number(qty) || 0));
  const unitPrice = Number(product.price) || 0;
  if (qty === 0) return { total: 0, breakdown: [] };

  const packs = [{ qty: 1, price: unitPrice, label: '' }];
  for (const t of (product.priceTiers || [])) {
    const tQty = Math.floor(Number(t.qty) || 0);
    const tPrice = Number(t.price);
    if (tQty >= 2 && tPrice >= 0) packs.push({ qty: tQty, price: tPrice, label: t.label || '' });
  }

  const dp = new Array(qty + 1).fill(Infinity);
  const pick = new Array(qty + 1).fill(-1);
  dp[0] = 0;
  for (let i = 1; i <= qty; i++) {
    for (let p = 0; p < packs.length; p++) {
      const pack = packs[p];
      if (pack.qty > i) continue;
      const cost = dp[i - pack.qty] + pack.price;
      const isBetter = cost < dp[i] || (cost === dp[i] && pick[i] >= 0 && pack.qty > packs[pick[i]].qty);
      if (isBetter) { dp[i] = cost; pick[i] = p; }
    }
  }

  const counts = new Map();
  let i = qty;
  while (i > 0 && pick[i] >= 0) {
    const p = pick[i];
    counts.set(p, (counts.get(p) || 0) + 1);
    i -= packs[p].qty;
  }
  const breakdown = [...counts.entries()]
    .map(([p, count]) => ({ qty: packs[p].qty, price: packs[p].price, count, label: packs[p].label }))
    .sort((a, b) => b.qty - a.qty);

  return { total: dp[qty], breakdown };
}

function formatBreakdown(breakdown, unit) {
  if (!breakdown || breakdown.length <= 1 && (breakdown[0]?.qty === 1)) return '';
  const rp = n => 'Rp' + (n || 0).toLocaleString('id-ID');
  const isMixed = breakdown.length > 1;
  return breakdown.map(b => {
    if (b.qty === 1) return `${b.count} ${unit || 'pcs'} x ${rp(b.price)}`;
    const name = b.label
      ? (isMixed ? `${b.label} (isi ${b.qty})` : b.label)
      : `paket ${b.qty}`;
    return `${b.count} ${name} x ${rp(b.price)}`;
  }).join(' + ');
}

module.exports = { calcLinePrice, formatBreakdown };
