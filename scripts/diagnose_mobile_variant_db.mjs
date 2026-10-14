// Read-only to cloud: this script has no cloud access. Disposable loopback PG only.
// Intentionally proves the existing defect, not repaired behavior or acceptance.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { openBusinessDb, ROOT } from "./helpers/business-db.mjs";
import { buildOpeningBalanceLines } from "../src/lib/ledger/audit.ts";
import { applyMovesToProducts } from "../src/lib/stockMirror.ts";
const db = await openBusinessDb();
try {
  const client = await db.client("ADMIN"), id=crypto.randomUUID(), supplier=crypto.randomUUID();
  await db.insert("products",{id,store_id:db.store,device_id:db.device,name:"Synthetic RED/BLUE",sku:id,quantity:50,metadata:{variants:[{name:"RED",stock:30},{name:"BLUE",stock:20}]}});
  await db.insert("suppliers",{id:supplier,store_id:db.store,device_id:db.device,companyName:"Synthetic supplier",contactPerson:"",phone:""});
  await client.query("select ledger_append($1)",[db.event("stock_adjustment","opening_balance",id,buildOpeningBalanceLines({productId:id,quantity:50,unitCost:2}))]);
  const row=async()=> (await db.admin.query("select to_jsonb(p) r from products p where store_id=$1 and id=$2",[db.store,id])).rows[0].r;
  const before=await row(), operation=crypto.randomUUID();
  const input={supplierId:supplier,paidAmount:0,wallet:"inStoreSafe",items:[{productId:id,productName:before.name,variantName:"RED",quantity:10,unitCost:2}]};
  const {rows:[{result}]}=await client.query("select record_financial_command($1,$2,$3,'receipt',$4) result",[operation,db.store,db.device,input]);
  const after=await row();
  const totals=(await db.admin.query("select account,sum(amount_delta)::int piastres,sum(qty_delta)::int qty from ledger_lines where store_id=$1 group by account order by account",[db.store])).rows;
  assert.equal(result.invoice.items[0].variantName,"RED","Mobile passes the variant onto the persisted invoice correctly");
  assert.equal(after.quantity,50,"backend leaves the product mirror unchanged; Mobile aggregate comes from the ledger");
  assert.deepEqual(after.metadata.variants,[{name:"RED",stock:30},{name:"BLUE",stock:20}],"confirmed defect: backend receipt does not credit variant metadata");
  assert.equal(totals.find(r=>r.account==="stock").qty,60);
  assert.equal(totals.find(r=>r.account==="stock").piastres,12000);
  assert.equal(totals.find(r=>r.account==="payable_supplier").piastres,2000);
  const moves=[{productId:id,variantName:"RED",delta:10}];
  const desktop=applyMovesToProducts([before],moves);
  const mobile=applyMovesToProducts([],moves);
  assert.equal(desktop.products[0].metadata.variants[0].stock,40);
  assert.deepEqual(mobile.touched,[],"Mobile never hydrates the Desktop catalog used by post-commit mirror writes");
  const replay=(await client.query("select record_financial_command($1,$2,$3,'receipt',$4) result",[operation,db.store,db.device,input])).rows[0].result;
  assert.equal(replay.replayed,true);
  assert.equal((await row()).quantity,50);
  const evidence={version:db.version,scope:"synthetic disposable loopback PostgreSQL only",finding:"CONFIRMED B persistence defect; NOT FIXED",before,after,invoice:result.invoice,totals,desktopMirror:desktop.products[0],mobileTouched:mobile.touched,replay:replay.replayed};
  const output=path.join(ROOT,"logs/final-v1-sprint/master-variant-diagnosis.json");
  fs.writeFileSync(output,JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({finding:evidence.finding,version:db.version,ledgerAggregate:60,productMirrorAggregate:after.quantity,variants:after.metadata.variants,stockPiastres:12000,payablePiastres:2000,evidence:output}));
} finally { await db.close(); }
