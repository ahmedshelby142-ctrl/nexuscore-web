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
  const cogsLine = saleLines.filter(l => l.account === "cogs" && l.subjectId === "BUNDLE-X");

  if (saleA[0]?.qty === -2 && saleB[0]?.qty === -1 && cogsLine[0]?.amount === 40) {
    console.log("✅ POS Sale unpacking and COGS correct.");
  } else {
    console.log("❌ POS Sale unpacking failed.");
    process.exit(1);
  }
}

runTest().catch(console.error);
