import { buildOrderPlacedLines, buildOrderCancelledLines } from "../src/lib/ledger/orders.ts";
import { buildSaleLines } from "../src/lib/ledger/sales.ts";

async function runTest() {
  console.log("Testing Bundle Unpacking in Ledger Builders...\n");

  const bundleProduct = {
    productId: "BUNDLE-X",
    quantity: 1,
    unitPrice: 100,
    unitCost: 40,
    isBundle: true,
    bundleItems: [
      { productId: "COMP-A", quantity: 2, unitCost: 10 },
      { productId: "COMP-B", quantity: 1, unitCost: 20 },
    ]
  };

  // 1. Order Placed
  console.log("1. Testing buildOrderPlacedLines...");
  const placedLines = buildOrderPlacedLines({
    items: [bundleProduct]
  });

  const stockLinesA = placedLines.filter(l => l.account === "stock" && l.subjectId === "COMP-A");
  const stockLinesB = placedLines.filter(l => l.account === "stock" && l.subjectId === "COMP-B");
  const stockLinesBundle = placedLines.filter(l => l.account === "stock" && l.subjectId === "BUNDLE-X");

  if (stockLinesA[0]?.qty === -2 && stockLinesB[0]?.qty === -1 && stockLinesBundle.length === 0) {
    console.log("✅ Order Placed unpacking correct.");
  } else {
    console.log("❌ Order Placed unpacking failed:", { stockLinesA, stockLinesB, stockLinesBundle });
    process.exit(1);
  }

  // 2. Order Cancelled
  console.log("\n2. Testing buildOrderCancelledLines...");
  const cancelledLines = buildOrderCancelledLines({
    items: [bundleProduct]
  });

  const cancelA = cancelledLines.filter(l => l.account === "stock" && l.subjectId === "COMP-A");
  const cancelB = cancelledLines.filter(l => l.account === "stock" && l.subjectId === "COMP-B");
  
  if (cancelA[0]?.qty === 2 && cancelB[0]?.qty === 1) {
    console.log("✅ Order Cancelled unpacking correct.");
  } else {
    console.log("❌ Order Cancelled unpacking failed.");
    process.exit(1);
  }

  // 3. POS Sale
  console.log("\n3. Testing buildSaleLines...");
  const saleLines = buildSaleLines({
    items: [bundleProduct],
    wallet: "safe"
  });

  const saleA = saleLines.filter(l => l.account === "stock" && l.subjectId === "COMP-A");
  const saleB = saleLines.filter(l => l.account === "stock" && l.subjectId === "COMP-B");
  // COGS is attributed to the COMPONENTS, matching the stock lines above, so a
  // per-product margin report reads the same subject on both sides. A بوكس has
  // no stock lines of its own, so COGS against the bundle id was an orphan.
  const cogsTotal = saleLines
    .filter(l => l.account === "cogs")
    .reduce((sum, l) => sum + (l.amount ?? 0), 0);
  const cogsOnBundle = saleLines.filter(l => l.account === "cogs" && l.subjectId === "BUNDLE-X");
  const cogsA = saleLines.filter(l => l.account === "cogs" && l.subjectId === "COMP-A");
  const cogsB = saleLines.filter(l => l.account === "cogs" && l.subjectId === "COMP-B");

  if (
    saleA[0]?.qty === -2 && saleB[0]?.qty === -1 &&
    cogsTotal === 40 && cogsA[0]?.amount === 20 && cogsB[0]?.amount === 20 &&
    cogsOnBundle.length === 0
  ) {
    console.log("✅ POS Sale unpacking and COGS correct.");
  } else {
    console.log("❌ POS Sale unpacking failed.", { cogsTotal, cogsA, cogsB, cogsOnBundle });
    process.exit(1);
  }

  // 4. The case the fixture above cannot catch on its own.
  //
  // A real بوكس is virtual: no purchases, no stock of its own, so
  // `costOf(bundleId)` is 0 and that is exactly what `CheckoutForm` passes as
  // `unitCost`. The old builder derived COGS from THAT, so `lineCost` was 0,
  // the `!== 0` guard skipped the line entirely, and the sale booked full
  // revenue against no cost at all. The fixture above only passed because it
  // set an artificial `unitCost: 40` that happened to equal the component sum.
  console.log("\n4. Testing a REAL virtual bundle (unitCost 0)...");
  const virtualBox = { ...bundleProduct, unitCost: 0 };
  const virtualLines = buildSaleLines({ items: [virtualBox], wallet: "safe" });
  const virtualCogs = virtualLines
    .filter(l => l.account === "cogs")
    .reduce((sum, l) => sum + (l.amount ?? 0), 0);
  const virtualRevenue = virtualLines
    .filter(l => l.account === "revenue")
    .reduce((sum, l) => sum + (l.amount ?? 0), 0);

  if (virtualCogs === 40 && virtualRevenue === 100 && virtualRevenue - virtualCogs === 60) {
    console.log("✅ Virtual bundle books component cost, not zero.");
  } else {
    console.log("❌ Virtual bundle COGS wrong:", { virtualCogs, virtualRevenue });
    process.exit(1);
  }
}

runTest().catch(console.error);
