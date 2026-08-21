import { buildSaleLines } from "../src/lib/ledger/sales.ts";
import { buildOrderDeliveredLines } from "../src/lib/ledger/orders.ts";

// Helper for assertions
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`FAIL: ${msg} | Expected ${expected}, got ${actual}`);
  }
}

console.log("Testing Discount Ledger Impacts...");

// 1. POS Sale with Discount
const saleLines = buildSaleLines({
  items: [
    { productId: "p1", quantity: 2, unitPrice: 100, unitCost: 40 }
  ], // Total = 200, Cost = 80
  wallet: "inStoreSafe",
  customerId: "c1",
  discountCodeId: "d1",
  discountAmount: 50 // Net Revenue = 150
});

let revenueLine = saleLines.find(l => l.account === "revenue");
let walletLine = saleLines.find(l => l.account === "wallet" && l.subjectId === "inStoreSafe");
let ltvLine = saleLines.find(l => l.account === "customer_ltv");

assertEqual(revenueLine.amount, 150, "POS Revenue should be net of discount (200 - 50)");
assertEqual(walletLine.amount, 150, "POS Wallet should receive net amount (200 - 50) and positive");
assertEqual(ltvLine.amount, 150, "POS Customer LTV should be net amount (200 - 50) and positive");

console.log("✅ POS Sale Discounts verified.");

// 2. Ecommerce Order with Discount
const orderLines = buildOrderDeliveredLines({
  orderNumber: "ORD-001",
  orderId: "o1",
  customerId: "c1",
  courierId: "courier1",
  courierName: "Courier One",
  items: [
    { productId: "p1", quantity: 1, unitPrice: 500, unitCost: 200 }
  ],
  goodsTotal: 500, // 500
  shippingFee: 50,
  depositAmount: 100,
  depositWallet: "instaPay",
  codAmount: 350, // (goodsTotal + shipping) - deposit
  courierFee: 40,
  discountCodeId: "d1",
  discountAmount: 100
});

// For Ecommerce Order:
// The deposit was 100 (already received)
// Expected COD = 350
// Total Revenue (Goods) should be 400 (500 - 100 discount)
// Shipping Revenue = 50
// Courier Expense = 40
// Receivable Courier = Expected COD = 350

revenueLine = orderLines.find(l => l.account === "revenue");
let receivableLine = orderLines.find(l => l.account === "receivable_courier");
ltvLine = orderLines.find(l => l.account === "customer_ltv");

assertEqual(revenueLine.amount, 400, "Order Revenue should be net of discount (400)");
assertEqual(receivableLine.amount, 350, "Receivable Courier should match Expected COD (350)");
assertEqual(ltvLine.amount, 400, "Order Customer LTV should be Net Goods Total (400)");

console.log("✅ Ecommerce Order Discounts verified.");
console.log("All discount tests passed!");
