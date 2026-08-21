/**
 * Finding a product by typing.
 *
 * The sibling of `orderSearch.ts`, same philosophy: one field, several
 * targets, no mode picker. It reuses that module's `normaliseSearchText` so
 * Arabic-Indic digits behave identically whether you are hunting an order or a
 * product — a SKU like "منتج-١٢٣" must match "123".
 *
 * Targets: product name and SKU/barcode. Every whitespace-separated word must
 * match somewhere, so "شنطة جلد" narrows instead of returning both halves.
 */

// Explicit extension so `node --test` can load this module directly, the same
// way the other ledger tests load theirs. `allowImportingTsExtensions` is on.
import { normaliseSearchText } from "./orderSearch.ts";

/** The fields a product search looks at. Any product-shaped object satisfies this. */
export interface SearchableProduct {
  name?: string;
  sku?: string;
  barcode?: string;
}

/** Does this product match everything the user typed? Empty query matches all. */
export function matchesProductQuery(product: SearchableProduct, query: string): boolean {
  const words = normaliseSearchText(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;

  const haystack = normaliseSearchText(
    [product.name, product.sku, product.barcode].filter(Boolean).join(" "),
  );

  return words.every((word) => haystack.includes(word));
}

/** Filter a product list by a typed query, preserving its order. */
export function searchProducts<T extends SearchableProduct>(products: T[], query: string): T[] {
  if (!query.trim()) return products;
  return products.filter((product) => matchesProductQuery(product, query));
}
