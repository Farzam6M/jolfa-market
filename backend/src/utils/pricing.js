/**
 * Effective per-unit price for a given quantity. If the product has one or
 * more WholesaleTier rows (`{ minQty, price }`), the tier with the highest
 * `minQty` that `qty` still satisfies wins; otherwise the product's regular
 * `price` is used. Shared by cart and checkout so both price a line item the
 * same way.
 */
function computeEffectivePrice(product, qty) {
  const tiers = product.wholesaleTiers || [];
  const eligible = tiers
    .filter((t) => qty >= t.minQty)
    .sort((a, b) => b.minQty - a.minQty);
  if (eligible.length) return Number(eligible[0].price);
  return Number(product.price);
}

module.exports = { computeEffectivePrice };
