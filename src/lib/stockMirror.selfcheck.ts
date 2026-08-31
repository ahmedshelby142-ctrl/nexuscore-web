/**
 * The mirror's arithmetic, checked. Pure — no store, no renderer.
 *
 *   npx tsx src/lib/stockMirror.selfcheck.ts
 */

import assert from "node:assert/strict";
import { applyMovesToProducts } from "@/lib/stockMirror";
import { getActualStock } from "@/lib/product";

const plain = () => ({ id: "p", name: "قميص", totalQuantity: 10 });
const varied = () => ({
  id: "v",
  name: "جاكيت",
  metadata: { variants: [{ name: "أحمر", stock: 5 }, { name: "أزرق", stock: 3 }] },
  totalQuantity: 8,
});

// ── The regression this whole change exists for ─────────────────────────────
// A product with NO variants must move. The five loops this replaced all
// opened with `if (line.variantName)` and left it frozen forever.
{
  const { products, touched } = applyMovesToProducts([plain()], [
    { productId: "p", delta: -3 },
  ]);
  assert.equal(getActualStock(products[0]), 7, "a plain product must decrement on a sale");
  assert.deepEqual(touched, ["p"]);
}

// ── Signed deltas, both directions, batched per product ─────────────────────
{
  const { products } = applyMovesToProducts([plain()], [
    { productId: "p", delta: -4 },
    { productId: "p", delta: -1 },
    { productId: "p", delta: +2 }, // a مرتجع in the same basket
  ]);
  assert.equal(getActualStock(products[0]), 7, "deltas sum before they are applied");
}

// ── The floor ───────────────────────────────────────────────────────────────
// Overselling is legal (نواقص); a negative shelf is not. What is owed lives
// in the open orders, so a negative here would silently eat the next توريد.
{
  const { products } = applyMovesToProducts([plain()], [{ productId: "p", delta: -25 }]);
  assert.equal(getActualStock(products[0]), 0, "stock floors at zero, never negative");
  const after = applyMovesToProducts(products, [{ productId: "p", delta: +5 }]);
  assert.equal(getActualStock(after.products[0]), 5, "and the next توريد lands in full");
}

// ── Variants ────────────────────────────────────────────────────────────────
{
  const { products } = applyMovesToProducts([varied()], [
    { productId: "v", delta: -2, variantName: "أحمر" },
  ]);
  const p: any = products[0];
  assert.equal(p.metadata.variants[0].stock, 3, "the named variant moved");
  assert.equal(p.metadata.variants[1].stock, 3, "the others did not");
  assert.equal(p.totalQuantity, 6, "totalQuantity is recomputed as the sum, not adjusted");
  assert.equal(getActualStock(p), 6);
}

// A drifted record: totalQuantity is repaired from the variants on any move.
{
  const drifted: any = varied();
  drifted.totalQuantity = 999;
  const { products } = applyMovesToProducts([drifted], [
    { productId: "v", delta: -1, variantName: "أزرق" },
  ]);
  assert.equal((products[0] as any).totalQuantity, 7, "drift is corrected, not carried");
}

// A move naming no variant on a variant product has no honest home — it must
// move nothing rather than charge the first درجة in the list.
{
  const before: any = varied();
  const { products } = applyMovesToProducts([before], [{ productId: "v", delta: -5 }]);
  const p: any = products[0];
  assert.equal(p.metadata.variants[0].stock, 5);
  assert.equal(p.metadata.variants[1].stock, 3);
  assert.equal(p.totalQuantity, 8, "an unplaceable move changes nothing");
}

// A variant name that matches nothing (the legacy name-split fallback in
// المرتجعات) is the same case: harmless.
{
  const { products } = applyMovesToProducts([varied()], [
    { productId: "v", delta: +9, variantName: "قميص أحمر كبير" },
  ]);
  assert.equal((products[0] as any).totalQuantity, 8);
}

// ── Isolation and no-ops ────────────────────────────────────────────────────
{
  const list = [plain(), varied()];
  const { products, touched } = applyMovesToProducts(list, [{ productId: "p", delta: -1 }]);
  assert.deepEqual(touched, ["p"]);
  assert.equal(products[1], list[1], "untouched products are returned by reference");
}

{
  const list = [plain()];
  for (const noop of [
    [] as any[],
    [{ productId: "p", delta: 0 }],
    [{ productId: "nope", delta: -5 }],
    [{ productId: "p", delta: NaN }],
  ]) {
    const { touched } = applyMovesToProducts(list, noop);
    assert.deepEqual(touched, [], `no-op: ${JSON.stringify(noop)}`);
  }
}

console.log("stock mirror self-check: ok");
