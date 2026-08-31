/**
 * The one product picker, for every screen that has to choose a product:
 * the online order form, the box/bundle component list (§3.10), exchanges.
 *
 * It replaces a `<select>` listing every product in the shop. A dropdown is
 * the wrong shape for this: it forces scrolling past hundreds of items to
 * reach one the user already knows the name of, and it hides stock until
 * after the pick.
 *
 * Two rules it holds:
 *
 *   - **One stock reader.** `sellableStock` — the same one POS, جملة,
 *     أونلاين and الجرد use — so the picker cannot show a different number
 *     from the screen that opened it.
 *   - **Out-of-stock stays visible but unpickable.** Hiding it makes the
 *     product look deleted and sends the user hunting; showing it greyed with
 *     "نفد المخزون" answers the question they actually have.
 */

import { useState, useMemo } from "react";
import { Search, X, PackageX } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { searchProducts } from "@/lib/productSearch";
import { productPrice, activeProducts, sellableStock } from "@/lib/product";
import { formatMoney, formatQty } from "@/lib/math";
import type { Product } from "@/types";

interface ProductSearchProps {
  products: Product[];
  onSelect: (product: Product) => void;
  /** Product ids already chosen, shown as "مضاف بالفعل" and not selectable. */
  excludeIds?: string[];
  placeholder?: string;
  /** How many results to render before asking the user to narrow the search. */
  limit?: number;
  /** Whether to allow selection of products with 0 stock (e.g. for restocking) */
  allowOutOfStock?: boolean;
}

export function ProductSearch({
  products,
  onSelect,
  excludeIds = [],
  placeholder,
  limit = 8,
  allowOutOfStock = false,
}: ProductSearchProps) {
  const [query, setQuery] = useState("");

  // Archived products never appear in a picker — this is the shared component
  // POS, orders, returns and bundles all pick through, so the rule holds in
  // one place instead of at every call site.
  const matches = useMemo(
    () => searchProducts(activeProducts(products), query),
    [products, query],
  );
  const shown = matches.slice(0, limit);

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder ?? "ابحث باسم المنتج أو الكود..."}
          className="pr-9 pl-9 h-10"
        />
        {query && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute left-1 top-1/2 -translate-y-1/2 size-7"
            onClick={() => setQuery("")}
            aria-label="مسح البحث"
          >
            <X className="size-4" />
          </Button>
        )}
      </div>

      {/* Results appear once the user types. Showing the whole catalogue
          before that would rebuild the scrolling list this replaced. */}
      {query.trim() && (
        <div className="rounded-xl border border-border bg-background divide-y divide-border max-h-72 overflow-y-auto">
          {shown.length === 0 ? (
            <div className="p-4 text-center space-y-1">
              <PackageX className="size-5 mx-auto text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                مفيش منتج مطابق — جرّب جزء من الاسم أو الكود
              </p>
            </div>
          ) : (
            shown.map((product) => {
              // Bundle-aware: a بوكس reads its recipe, not its own record.
              const stock = sellableStock(product, products);
              const already = excludeIds.includes(product.id);
              const disabled = (!allowOutOfStock && stock <= 0) || already;

              return (
                <button
                  key={product.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    onSelect(product);
                    setQuery("");
                  }}
                  className={cn(
                    "w-full flex items-center justify-between gap-3 p-3 text-right transition-colors",
                    disabled ? "opacity-50 cursor-not-allowed" : "hover:bg-accent",
                  )}
                >
                  {product.image_url ? (
                    <img src={product.image_url} alt={product.name} className="size-10 object-cover rounded bg-muted shrink-0" />
                  ) : (
                    <div className="size-10 rounded bg-muted shrink-0 flex items-center justify-center">
                      <span className="text-xs text-muted-foreground">{product.name.substring(0, 2)}</span>
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{product.name}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {product.sku} — {formatMoney(productPrice(product))}
                    </p>
                  </div>

                  <span
                    className={cn(
                      "text-xs font-medium shrink-0 rounded-lg px-2 py-1",
                      already
                        ? "bg-muted text-muted-foreground"
                        : stock <= 0
                          ? "bg-destructive/10 text-destructive"
                          : "bg-green-50 dark:bg-green-950/40 text-green-700 dark:text-green-400",
                    )}
                  >
                    {already
                      ? "مضاف بالفعل"
                      : stock <= 0
                        ? "نفد المخزون"
                        : `المخزون: ${formatQty(stock)}`}
                  </span>
                </button>
              );
            })
          )}

          {matches.length > shown.length && (
            <p className="p-2 text-center text-xs text-muted-foreground">
              وكمان {formatQty(matches.length - shown.length)} نتيجة — اكتب أكتر عشان تضيّق البحث
            </p>
          )}
        </div>
      )}
    </div>
  );
}
