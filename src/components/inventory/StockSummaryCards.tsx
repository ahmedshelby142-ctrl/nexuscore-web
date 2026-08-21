/**
 * The four stock summary cards, shared by المنتجات and المخازن.
 *
 * One component, one set of numbers. Two copies of this arithmetic would drift
 * the moment either screen changed — and "the same number differs between two
 * screens" is the exact bug this whole conversion exists to delete.
 *
 * Every figure is read from the ledger: quantity is `SUM(stock)` per product
 * and the value card multiplies it by the weighted-average cost the purchase
 * path derived. Nothing here reads `product.quantity` or `product.costPrice` —
 * those are stored fields that no longer track reality.
 */

import { Package, AlertTriangle, PackageCheck, DollarSign } from "lucide-react";
import { productMinLevel } from "@/lib/product";
import { formatMoney } from "@/lib/math";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useStock } from "@/lib/ledger/useStock";

/** Which subset of products a screen is showing. */
export type StockFilter = "all" | "low" | "out";

/** The fields these cards need. Deliberately not the whole `Product`. */
export interface StockCardProduct {
  id: string;
  minStockLevel?: number;
}

/**
 * The level at which a product counts as "low".
 *
 * This local interface is why the compiler could not find this reader when
 * `reorder_point` was deleted from `Product`: it re-declared the ghost field
 * itself. The chain read `minStockLevel ?? reorder_point ?? 0` and always fell
 * through the middle term, because nothing ever wrote `reorder_point`.
 */
export function reorderPointOf(product: StockCardProduct): number {
  return productMinLevel(product);
}

/**
 * A product's stock status, from its ledger quantity.
 *
 * Exported so the tables on both screens label a row the same way the cards
 * counted it. If a card says 3 are low, three rows must show "منخفض".
 */
export function stockStatusOf(
  quantity: number,
  product: StockCardProduct,
): { label: string; variant: "destructive" | "secondary" | "default" } {
  if (quantity <= 0) return { label: "نفد", variant: "destructive" };
  if (quantity <= reorderPointOf(product)) return { label: "منخفض", variant: "secondary" };
  return { label: "متوفر", variant: "default" };
}

/** Does this product belong in the current filter? */
export function matchesStockFilter(
  quantity: number,
  product: StockCardProduct,
  filter: StockFilter,
): boolean {
  if (filter === "low") return quantity > 0 && quantity <= reorderPointOf(product);
  if (filter === "out") return quantity <= 0;
  return true;
}

interface StockSummaryCardsProps {
  products: StockCardProduct[];
  value: StockFilter;
  onChange: (filter: StockFilter) => void;
}

export function StockSummaryCards({ products, value, onChange }: StockSummaryCardsProps) {
  const { qtyOf, costOf } = useStock();

  let lowStock = 0;
  let outOfStock = 0;
  let totalValue = 0;
  for (const product of products) {
    const qty = qtyOf(product.id);
    if (qty <= 0) outOfStock += 1;
    else if (qty <= reorderPointOf(product)) lowStock += 1;
    // Inventory is worth what it cost, not what it might sell for.
    totalValue += qty * costOf(product.id);
  }

  // Clicking the active filter clears it, so a card is a toggle rather than a
  // trap the user has to hunt for a way out of.
  const toggle = (filter: StockFilter) => onChange(value === filter ? "all" : filter);

  const cards = [
    {
      key: "all" as const,
      label: "إجمالي المنتجات",
      figure: String(products.length),
      icon: Package,
      colour: "var(--chart-1)",
      onClick: () => onChange("all"),
    },
    {
      key: "low" as const,
      label: "منتجات منخفضة",
      figure: String(lowStock),
      icon: AlertTriangle,
      colour: "#f59e0b",
      onClick: () => toggle("low"),
    },
    {
      key: "out" as const,
      label: "منتجات نافدة",
      figure: String(outOfStock),
      icon: PackageCheck,
      colour: "var(--destructive)",
      onClick: () => toggle("out"),
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5">
      {cards.map((card) => {
        const Icon = card.icon;
        const active = value === card.key;
        return (
          <Card
            key={card.key}
            onClick={card.onClick}
            className={cn(
              "overflow-hidden cursor-pointer select-none transition-all duration-200",
              active && "ring-2 ring-offset-2",
            )}
            style={active ? ({ "--tw-ring-color": card.colour } as React.CSSProperties) : undefined}
          >
            <CardContent className="p-5">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs tracking-wider text-muted-foreground">{card.label}</p>
                  <p className="font-display text-3xl font-semibold mt-2">{card.figure}</p>
                </div>
                <div
                  className="size-10 rounded-xl flex items-center justify-center"
                  style={{
                    backgroundColor: `color-mix(in oklab, ${card.colour} 15%, transparent)`,
                    color: card.colour,
                  }}
                >
                  <Icon className="size-5" />
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}

      {/* Value is not a filter — there is no "expensive" subset to show. */}
      <Card className="overflow-hidden">
        <CardContent className="p-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs tracking-wider text-muted-foreground">إجمالي قيمة المخزون</p>
              <p className="font-display text-3xl font-semibold mt-2">
                {formatMoney(totalValue)}
              </p>
            </div>
            <div
              className="size-10 rounded-xl flex items-center justify-center"
              style={{
                backgroundColor: "color-mix(in oklab, var(--chart-2) 15%, transparent)",
                color: "var(--chart-2)",
              }}
            >
              <DollarSign className="size-5" />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
