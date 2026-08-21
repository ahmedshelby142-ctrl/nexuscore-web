/**
 * The e-commerce order lifecycle, as ledger lines.
 *
 * An online order is not one moment — it is a sequence, and each step writes
 * its own event:
 *
 *   order_placed            stock −            goods reserved, nothing sold yet
 *   order_delivered         revenue/cogs/COD   the sale actually happens here
 *   order_returned_pending  NOTHING            courier says returned, goods not back
 *   return_confirmed        six lines          a human confirmed they arrived
 *
 * The split between the last two is the whole point of §3.9: a courier marking
 * something "returned" is a claim, not an arrival. Stock must not increase on a
 * claim.
 *
 * Pure, like the other builders, so the money rules are testable without a DB.
 */

import type { NewLine } from "./types";

export interface OrderLineItem {
  productId: string;
  quantity: number;
  /** Price per unit charged to the customer, EGP. */
  unitPrice: number;
  /** Cost per unit, EGP, derived from the ledger. Never a product field. */
  unitCost: number;
  /** The selected product variant (shade/color), if any. */
  variantName?: string;
  /** Whether this item is a bundle/kit of other products. */
  isBundle?: boolean;
  /** The components making up this bundle, if isBundle is true. */
  bundleItems?: { productId: string; quantity: number; unitCost: number }[];
}

export interface OrderPlacedInput {
  items: OrderLineItem[];
  /** Advance deposit paid up front, EGP. Lands in a till now. */
  depositAmount?: number;
  /** The till the deposit lands in. Required when there is one. */
  wallet?: string;
}

/**
 * Placing an order reserves stock — and books the advance deposit, if any.
 *
 * Quantity AND value leave together. Moving only the quantity would leave the
 * same inventory value spread over fewer units, silently inflating the
 * weighted-average cost of everything still on the shelf — every later sale
 * would book too much COGS.
 *
 * No revenue, no COGS, no LTV: a placed order is not a sale. Those land at
 * delivery, which is the moment the money is real.
 *
 * The deposit, however, IS real money already received (InstaPay, Vodafone
 * Cash, bank transfer). Deferring it to delivery leaves the wallet understated
 * while the order is pending, and if the order is cancelled the money is never
 * recorded at all — a permanent ghost in the till.
 */
export function buildOrderPlacedLines(order: OrderPlacedInput): NewLine[] {
  if (order.items.length === 0) {
    throw new Error("order: cannot place an order with no items");
  }

  const lines: NewLine[] = [];
  for (const item of order.items) {
    if (item.quantity === 0) {
      throw new Error(`order: quantity for ${item.productId} must not be zero`);
    }
    
    if (item.isBundle && item.bundleItems) {
      for (const comp of item.bundleItems) {
        lines.push({
          account: "stock",
          subjectId: comp.productId,
          qty: -(comp.quantity * item.quantity),
          amount: -(comp.unitCost * comp.quantity * item.quantity),
        });
      }
    } else {
      lines.push({
        account: "stock",
        subjectId: item.productId,
        qty: -item.quantity,
        amount: -(item.unitCost * item.quantity),
      });
    }
  }

  const deposit = order.depositAmount ?? 0;
  if (deposit < 0) throw new Error("order: deposit cannot be negative");
  if (deposit > 0) {
    if (!order.wallet) throw new Error("order: needs a wallet for the deposit");
    lines.push({ account: "wallet", subjectId: order.wallet, amount: deposit });
  }

  return lines;
}

export interface OrderDeliveredInput {
  items: OrderLineItem[];
  /** The goods only, EGP. This — and only this — is our revenue. */
  goodsTotal: number;
  /**
   * The delivery fee, EGP, snapshotted from the Settings rate matrix at the
   * moment of delivery.
   *
   * The CUSTOMER pays this and it passes straight through us to the courier,
   * so it is neither our revenue nor our expense. It arrives inside the money
   * collected and leaves as `payable_courier`. Booking it as revenue would
   * inflate profit by every delivery fee ever charged; booking it as expense
   * would make shipping look like a loss it is not.
   */
  shippingFee?: number;
  /** Who carries it. Required when there is a fee to owe them. */
  courierId?: string;
  /**
   * Already paid up front and booked at `order_placed`. Needed here only for
   * the arithmetic validation (deposit + cod = collected). No wallet line is
   * written — the money is already in the till.
   */
  depositAmount?: number;
  /**
   * Kept for backward compatibility. The deposit wallet line was moved to
   * `order_placed`; this field is no longer consumed by the builder.
   */
  wallet?: string;
  /** Cash the courier collects on delivery — they owe it to us until settled. */
  codAmount?: number;
  /** Omit for a guest order — no LTV line is written. */
  customerId?: string;
  /** Revenue channel, for reporting. */
  channel?: string;
  discountCodeId?: string;
  discountAmount?: number;
}

/**
 * Delivery is where the sale is booked: revenue, the cost of what went out,
 * the money, and the customer's lifetime value.
 *
 * The money splits two ways. What the customer already paid lands in a till.
 * What the courier collects at the door is `receivable_courier` — cash that
 * exists but is in someone else's pocket. It becomes wallet money later, at
 * `courier_settlement`. Booking COD straight into the till would show money the
 * shop does not yet have.
 */
export function buildOrderDeliveredLines(order: OrderDeliveredInput): NewLine[] {
  const lines: NewLine[] = [];

  let cogs = 0;
  for (const item of order.items) {
    cogs += item.unitCost * item.quantity;
  }

  // Cost of what left, per product. The stock itself already moved at
  // order_placed — this books that value as a cost of goods SOLD, which it
  // only became now.
  for (const item of order.items) {
    const lineCost = item.unitCost * item.quantity;
    if (lineCost !== 0) {
      lines.push({
        account: "cogs",
        subjectId: item.productId,
        amount: lineCost,
        unitCost: item.unitCost,
      });
    }
  }

  const deposit = order.depositAmount ?? 0;
  const cod = order.codAmount ?? 0;
  const shippingFee = order.shippingFee ?? 0;
  if (deposit < 0 || shippingFee < 0) {
    throw new Error("order: deposit and shipping fee cannot be negative");
  }
  const discount = order.discountAmount ?? 0;
  if (discount < 0) {
    throw new Error("order: discount cannot be negative");
  }
  const netGoodsTotal = Math.max(0, order.goodsTotal - discount);

  // The customer pays for the goods AND the delivery, so the money collected
  // has to cover both. A silent mismatch would mean the books and the cash
  // disagreeing forever.
  const collected = netGoodsTotal + shippingFee;
  if (deposit + cod !== collected) {
    throw new Error(
      `order: deposit (${deposit}) + COD (${cod}) must equal net goods (${netGoodsTotal}) + shipping (${shippingFee}) = ${collected}`,
    );
  }

  // The deposit was already booked at order_placed — the money was physically
  // received at that moment (InstaPay, Vodafone Cash, bank transfer). Booking
  // it again here would double-count the money in the wallet.
  if (cod > 0) {
    if (!order.courierId) throw new Error("order: needs a courier to hold the COD");
    lines.push({ account: "receivable_courier", subjectId: order.courierId, amount: cod });
  }



  // Revenue is the net goods. The delivery fee is not ours to book.
  lines.push({
    account: "revenue",
    subjectId: order.channel ?? "ecommerce",
    amount: netGoodsTotal,
  });

  // What we owe the courier for carrying it. Together with the fee sitting
  // inside the money collected above, this nets to zero — which is exactly
  // what a pass-through should do.
  if (shippingFee > 0) {
    if (!order.courierId) throw new Error("order: needs a courier to owe the delivery fee to");
    lines.push({ account: "payable_courier", subjectId: order.courierId, amount: shippingFee });
  }

  if (order.customerId) {
    // LTV mirrors revenue: what they spent WITH US, not what they paid the
    // courier through us.
    lines.push({ account: "customer_ltv", subjectId: order.customerId, amount: netGoodsTotal });
  }

  return lines;
}

/**
 * The courier says the order came back. Nothing happens on the ledger.
 *
 * Deliberately empty, and `appendEvent` allows an empty line list for exactly
 * this kind. The event exists so the claim is recorded and auditable — who said
 * it, when — while stock, money and LTV stay untouched until a human confirms
 * the goods physically arrived (brief §3.9).
 *
 * If this ever returns lines, stock increases on a courier's word, and the
 * shop believes it has goods sitting in someone's van.
 */
export function buildReturnPendingLines(): NewLine[] {
  return [];
}

/**
 * Cancelling a pending order puts the reserved stock back.
 *
 * The third reverse direction on the online path, and the easiest to forget:
 * `order_placed` takes stock out at creation, and if a cancel only deleted the
 * order document, those units would be gone from the shelf with nothing left
 * pointing at them — inventory swallowed silently, forever.
 *
 * Only valid before delivery. Once delivered, goods coming back is a return,
 * which reverses money as well.
 */
export function buildOrderCancelledLines(order: OrderPlacedInput): NewLine[] {
  if (order.items.length === 0) {
    throw new Error("order: cannot cancel an order with no items");
  }

  const lines: NewLine[] = [];
  for (const item of order.items) {
    if (item.quantity === 0) {
      throw new Error(`order: quantity for ${item.productId} must not be zero`);
    }

    if (item.isBundle && item.bundleItems) {
      for (const comp of item.bundleItems) {
        lines.push({
          account: "stock",
          subjectId: comp.productId,
          qty: comp.quantity * item.quantity,
          amount: comp.unitCost * comp.quantity * item.quantity,
        });
      }
    } else {
      lines.push({
        account: "stock",
        subjectId: item.productId,
        qty: item.quantity,
        amount: item.unitCost * item.quantity,
      });
    }
  }

  // If the customer paid a deposit at order_placed, it was booked as
  // wallet +deposit then. Cancellation must reverse it: the money is handed
  // back (or credited) and the wallet comes down by the same amount.
  //
  // Orders placed BEFORE the `depositWallet` field was introduced carry
  // `depositAmount > 0` but no wallet. Those orders never booked the deposit
  // at placement (it was deferred to delivery under the old accounting), so
  // there is nothing to reverse. Skipping rather than throwing is correct.
  const deposit = order.depositAmount ?? 0;
  if (deposit > 0 && order.wallet) {
    lines.push({ account: "wallet", subjectId: order.wallet, amount: -deposit });
  }

  return lines;
}

export interface OrderEditInput {
  /** What the order reserved before the edit, at the cost it reserved them at. */
  before: OrderLineItem[];
  /** What it should reserve after. New products carry today's ledger cost. */
  after: OrderLineItem[];
}

/**
 * Editing a pending order — one event, both directions.
 *
 * An edit is conceptually "release the old reservation, take a new one". It is
 * NOT written that way: the old `order_placed` event is never touched (the
 * ledger is append-only), and the release and the re-reservation are not two
 * separate events either, because an edit is one operation and splitting it
 * would let half of it land — stock released, nothing re-reserved.
 *
 * So it writes ONE event holding the net movement per product:
 *
 *   removed or reduced → `stock +`  at the cost it was reserved at
 *   added or increased → `stock −`  at today's ledger cost
 *
 * Products whose quantity did not change write nothing. Swapping A for B is
 * therefore two lines — A back, B out — not four.
 */
export function buildOrderEditLines(edit: OrderEditInput): NewLine[] {
  const before = new Map(edit.before.map((i) => [i.productId, i]));
  const after = new Map(edit.after.map((i) => [i.productId, i]));

  for (const item of edit.after) {
    if (item.quantity === 0) {
      throw new Error(`order edit: quantity for ${item.productId} must not be zero`);
    }
  }

  const lines: NewLine[] = [];
  for (const productId of new Set([...before.keys(), ...after.keys()])) {
    const had = before.get(productId)?.quantity ?? 0;
    const wants = after.get(productId)?.quantity ?? 0;
    const delta = wants - had;
    if (delta === 0) continue;

    // Releasing uses the cost the units were reserved at, so the value that
    // went out is exactly the value that comes back. Reserving more uses
    // today's cost, like any other reservation.
    const unitCost =
      delta < 0 ? (before.get(productId)?.unitCost ?? 0) : (after.get(productId)?.unitCost ?? 0);

    lines.push({
      account: "stock",
      subjectId: productId,
      qty: -delta,
      amount: -(delta * unitCost),
    });
  }

  return lines;
}

/** The order's goods total after an edit, EGP. Shipping is added by the caller. */
export function orderItemsTotal(items: OrderLineItem[]): number {
  return items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
}

export interface ReturnConfirmedInput {
  items: OrderLineItem[];
  /** What is being handed back to the customer, EGP. */
  refundAmount: number;
  /** The till the refund comes out of. */
  wallet: string;
  /** Revenue being reversed — the original order total, EGP. */
  revenueAmount: number;
  /**
   * The courier's fee for this movement, EGP, snapshotted from the Settings
   * rate matrix. Who pays it depends on `movement` — see below.
   */
  returnFee?: number;
  /**
   * Which movement this is, because the two are priced AND borne differently:
   *
   *   "return"   goods come back to US — WE pay the courier → our `expense +`
   *   "exchange" the customer swaps — THE CUSTOMER pays → pass-through, no expense
   *
   * Booking an exchange's fee as our expense would invent a cost the shop never
   * bore and quietly understate profit on every swap.
   */
  movement?: "return" | "exchange";
  /** The courier owed the fee. Required when there is one. */
  courierId?: string;
  /** The customer whose LTV must come back down. */
  customerId?: string;
  channel?: string;
}

/**
 * A confirmed return writes SIX lines. Missing any one is a bug — see the
 * checklist in docs/LEDGER_SCHEMA.md.
 *
 *   stock +         the units are physically back
 *   wallet −        the refund
 *   revenue −       reverse the sale
 *   cogs −          the goods came back, so their cost is no longer a cost of
 *                   goods *sold*; without this, margin reports understate profit
 *   expense +       the courier's return fee
 *   customer_ltv −  the line the smoke test caught going missing
 *
 * The LTV line is the one to watch. A return that balances stock and cash while
 * leaving LTV intact passes a careless test and still tells the CRM the customer
 * spent money they sent back.
 */
export function buildReturnConfirmedLines(ret: ReturnConfirmedInput): NewLine[] {
  const lines: NewLine[] = [];
  for (const item of ret.items) {
    if (item.quantity <= 0) {
      throw new Error(`return: quantity for ${item.productId} must be positive`);
    }

    const lineCost = item.unitCost * item.quantity;

    // The units come back, carrying their value back into inventory.
    if (item.isBundle && item.bundleItems) {
      for (const comp of item.bundleItems) {
        lines.push({
          account: "stock",
          subjectId: comp.productId,
          qty: comp.quantity * item.quantity,
          amount: comp.unitCost * comp.quantity * item.quantity,
        });
      }
    } else {
      lines.push({
        account: "stock",
        subjectId: item.productId,
        qty: item.quantity,
        amount: lineCost,
      });
    }

    // And their cost stops being a cost of goods sold.
    if (lineCost !== 0) {
      lines.push({
        account: "cogs",
        subjectId: item.productId,
        amount: -lineCost,
        unitCost: item.unitCost,
      });
    }
  }

  if (ret.refundAmount < 0) {
    throw new Error("return: refund cannot be negative");
  }
  if (ret.refundAmount > 0) {
    lines.push({ account: "wallet", subjectId: ret.wallet, amount: -ret.refundAmount });
  }

  lines.push({
    account: "revenue",
    subjectId: ret.channel ?? "ecommerce",
    amount: -ret.revenueAmount,
  });

  const fee = ret.returnFee ?? 0;
  if (fee > 0) {
    if (!ret.courierId) throw new Error("return: needs a courier to owe the fee to");
    const movement = ret.movement ?? "return";

    // We owe the courier either way — they did the work.
    lines.push({ account: "payable_courier", subjectId: ret.courierId, amount: fee });

    if (movement === "return") {
      // Goods coming back to us is the ONE shipping movement the shop pays for.
      lines.push({ account: "expense", subjectId: "shipping_return", amount: fee });
    } else {
      // An exchange fee is the customer's. The courier collects it on our
      // behalf, so it lands as a receivable and cancels what we owe them —
      // it is never our cost.
      lines.push({ account: "receivable_courier", subjectId: ret.courierId, amount: fee });
    }
  }

  if (ret.customerId) {
    lines.push({
      account: "customer_ltv",
      subjectId: ret.customerId,
      amount: -ret.revenueAmount,
    });
  }

  return lines;
}

export interface OrderRTOInput {
  items: OrderLineItem[];
  /**
   * The courier's fee for this movement, EGP, snapshotted from the Settings
   * rate matrix.
   */
  returnFee?: number;
  /** The courier owed the fee. Required when there is one. */
  courierId?: string;
}

/**
 * A refused delivery (RTO) writes lines for the goods coming back and the shipping fee.
 *
 *   stock +         the units are physically back
 *   expense +       the courier's return fee
 *   payable_courier + owe the courier the fee
 *
 * Notice there is NO `revenue -` and NO `customer_ltv -`, because for a shipped
 * order that was never delivered, those were never booked in the first place!
 * Also, no COGS reversal, because COGS was never booked.
 */
export function buildOrderRTOLines(rto: OrderRTOInput): NewLine[] {
  const lines: NewLine[] = [];
  for (const item of rto.items) {
    if (item.quantity <= 0) {
      throw new Error(`RTO: quantity for ${item.productId} must be positive`);
    }

    const lineCost = item.unitCost * item.quantity;

    if (item.isBundle && item.bundleItems) {
      for (const comp of item.bundleItems) {
        lines.push({
          account: "stock",
          subjectId: comp.productId,
          qty: comp.quantity * item.quantity,
          amount: comp.unitCost * comp.quantity * item.quantity,
        });
      }
    } else {
      lines.push({
        account: "stock",
        subjectId: item.productId,
        qty: item.quantity,
        amount: lineCost,
      });
    }
    // No COGS line, because COGS was never booked at order_placed.
  }

  const fee = rto.returnFee ?? 0;
  if (fee > 0) {
    if (!rto.courierId) throw new Error("RTO: needs a courier to owe the fee to");
    lines.push({ account: "payable_courier", subjectId: rto.courierId, amount: fee });
    lines.push({ account: "expense", subjectId: "shipping_return", amount: fee });
  }

  return lines;
}

export interface CourierSettlementInput {
  courierId: string;
  /** The till the courier's cash lands in. */
  wallet: string;
  /** What the courier is handing over, EGP — the COD they collected. */
  amount: number;
  /**
   * Fees withheld from the handover, EGP — the shipping fees already booked to
   * `payable_courier` when each movement happened.
   *
   * This clears the debt; it does NOT book an expense. The expense (returns
   * only) was recorded at the movement. Booking it again here would count every
   * return's shipping twice.
   */
  commission?: number;
}

/**
 * The courier hands over what they collected: cash in, receivable down.
 *
 * The other direction of the `receivable_courier` line that `order_delivered`
 * writes. Without it that account could only ever grow, and the shop's books
 * would show every courier permanently owing every COD ever collected.
 *
 * The commission never touches the till — it is money the courier keeps — so
 * the wallet gets `amount − commission` while the receivable clears in full.
 */
export function buildCourierSettlementLines(settlement: CourierSettlementInput): NewLine[] {
  if (settlement.amount <= 0) {
    throw new Error("courier settlement: amount must be positive");
  }
  const commission = settlement.commission ?? 0;
  if (commission < 0) {
    throw new Error("courier settlement: commission cannot be negative");
  }
  if (commission > settlement.amount) {
    throw new Error("courier settlement: commission is more than the amount collected");
  }

  const lines: NewLine[] = [
    { account: "wallet", subjectId: settlement.wallet, amount: settlement.amount - commission },
    {
      account: "receivable_courier",
      subjectId: settlement.courierId,
      amount: -settlement.amount,
    },
  ];

  // Withheld fees clear what we owed them. No expense line: whatever was our
  // cost was booked when the movement happened, and what was the customer's
  // was never ours to book.
  if (commission > 0) {
    lines.push({
      account: "payable_courier",
      subjectId: settlement.courierId,
      amount: -commission,
    });
  }

  return lines;
}

export interface CourierBatchSettlementInput {
  courierId: string;
  /** The till the lump sum lands in. */
  wallet: string;
  /** The orders this one transfer covered, with the COD each still has open and any courier fee. */
  orders: { orderId: string; cod: number; fee?: number }[];
  /**
   * The lump sum ACTUALLY received, EGP — what the bank/hand-over shows, not
   * what the orders add up to. The gap between the two is the point.
   */
  netReceived: number;
  /** Expected total fees across the batch if pre-calculated. */
  expectedFees?: number;
}

/**
 * One transfer, many orders (§3.9).
 *
 * The courier does not pay per delivery. Every 3–7 days it sends ONE lump sum
 * covering many delivered orders, already net of its commissions and any
 * return fees.
 *
 * This is **strict reconciliation**: every fee was already priced by
 * the Settings matrix and booked to `payable_courier` at the moment of the
 * movement.
 *
 *   wallet            + netReceived           the money that really arrived
 *   receivable_courier − codTotal             those orders are no longer with them
 *   payable_courier    − expectedFees/withheld clears what we owed them
 *   expense           + shortfall             (if difference > 0) books shortfall
 *
 * Partial batches are the norm — an order the courier has not paid for yet is
 * simply not in `orders`, stays open, and turns up in the next transfer.
 */
export function buildCourierBatchSettlementLines(input: CourierBatchSettlementInput): NewLine[] {
  if (input.orders.length === 0) {
    throw new Error("courier batch: pick at least one order for this transfer");
  }

  const seen = new Set<string>();
  let codTotal = 0;
  let calculatedFees = 0;
  for (const order of input.orders) {
    if (seen.has(order.orderId)) {
      throw new Error(`courier batch: ${order.orderId} is in this batch twice`);
    }
    seen.add(order.orderId);
    if (order.cod <= 0) {
      throw new Error(`courier batch: ${order.orderId} has no COD with the courier`);
    }
    codTotal += order.cod;
    calculatedFees += order.fee ?? 0;
  }

  if (input.netReceived < 0) {
    throw new Error("courier batch: the amount received cannot be negative");
  }
  // More than the orders were carrying is not a settlement OF those orders —
  // it is a different transaction, and guessing which would invent money.
  if (input.netReceived > codTotal) {
    throw new Error(
      `courier batch: received (${input.netReceived}) is more than the COD of the ticked orders (${codTotal})`,
    );
  }

  const expectedFees = input.expectedFees ?? calculatedFees;
  const lines: NewLine[] = [];

  if (input.netReceived > 0) {
    lines.push({ account: "wallet", subjectId: input.wallet, amount: input.netReceived });
  }
  lines.push({
    account: "receivable_courier",
    subjectId: input.courierId,
    amount: -codTotal,
  });

  if (expectedFees > 0) {
    const expectedNet = codTotal - expectedFees;
    const shortfall = expectedNet - input.netReceived;

    if (shortfall > 0) {
      // Clear expected courier fees in full from payable_courier
      lines.push({
        account: "payable_courier",
        subjectId: input.courierId,
        amount: -expectedFees,
      });
      // Book the shortfall/deficit as an explicit expense
      lines.push({
        account: "expense",
        subjectId: "courier_shortfall",
        amount: shortfall,
      });
    } else {
      // Net received is >= expectedNet; clear what was actually withheld
      const withheld = codTotal - input.netReceived;
      if (withheld > 0) {
        lines.push({
          account: "payable_courier",
          subjectId: input.courierId,
          amount: -withheld,
        });
      }
    }
  } else {
    // Legacy / fee-less batch: what was withheld clears payable_courier
    const withheld = codTotal - input.netReceived;
    if (withheld > 0) {
      lines.push({ account: "payable_courier", subjectId: input.courierId, amount: -withheld });
    }
  }

  return lines;
}
