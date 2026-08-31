/**
 * The ONE opening-balance write path.
 *
 * A shop that already owns stock on the day it installs the app states what is
 * on the shelf, and that assertion is recorded as one real `stock_adjustment`
 * event (RULES §3) — never a stored quantity. Two screens let the user make
 * that assertion: the product form ("الكمية الموجودة حالياً") and the Excel
 * importer's quantity column.
 *
 * They both call this. When the form was converted and the importer was not,
 * the importer kept writing the dead `quantity` field and every imported shop
 * opened at zero stock. One function is what makes that split impossible to
 * repeat: change the event here and both screens change with it.
 */

import { appendEvent } from "./index";
import { buildOpeningBalanceLines } from "./audit";

export interface OpeningBalanceEntry {
  productId: string;
  /** Descriptive only — the number lives in the lines. */
  productName: string;
  /** What the owner says is on the shelf right now. */
  quantity: number;
  /** What a unit cost them, EGP. Feeds the same weighted average as a توريد. */
  unitCost?: number;
}

/**
 * Append one opening-balance event, or none.
 *
 * Returns the event id, or `null` when there is no quantity to record — a
 * product with no opening stock starts at zero and fills up the normal way,
 * through a توريد. Callers do not repeat that rule.
 */
export async function appendOpeningBalance(entry: OpeningBalanceEntry): Promise<string | null> {
  if (!(entry.quantity > 0)) return null;

  return appendEvent({
    kind: "stock_adjustment",
    actor: "رصيد افتتاحي",
    refType: "opening_balance",
    refId: entry.productId,
    payload: { productName: entry.productName, quantity: entry.quantity },
    lines: buildOpeningBalanceLines({
      productId: entry.productId,
      quantity: entry.quantity,
      unitCost: entry.unitCost ?? 0,
    }),
  });
}
