// Default: verify the repaired 59-versus49 case in the full local candidate.
// --historical-baseline reproduces the original defect without the new stock
// migration. Original failure evidence is retained, never overwritten.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {openBusinessDb,read,ROOT} from './helpers/business-db.mjs';
import {buildOpeningBalanceLines} from '../src/lib/ledger/audit.ts';
import {buildSaleLines} from '../src/lib/ledger/sales.ts';
import {applyMovesToProducts,stockMirrorPatch} from '../src/lib/stockMirror.ts';
const db=await openBusinessDb();
const verify=!process.argv.includes('--historical-baseline');
try{
 const c=await db.client('ADMIN'),id=crypto.randomUUID(),supplier=crypto.randomUUID();
 await db.admin.query(read('supabase/migrations/20261012080415_receipt_variant_stock.sql'));
 if(verify)for(const name of ['20261012082556_pos_atomic_exchange','20261012090535_courier_atomic_batch','20261012191715_authoritative_stock_commands'])
  await db.admin.query(read('supabase/migrations/'+name+'.sql'));
 await db.insert('products',{id,store_id:db.store,device_id:db.device,name:'Synthetic concurrency diagnostic',sku:id,quantity:50,metadata:{variants:[{name:'RED',stock:30},{name:'BLUE',stock:20}]}});
 await db.insert('suppliers',{id:supplier,store_id:db.store,device_id:db.device,companyName:'Synthetic supplier',contactPerson:'',phone:''});
 await c.query('select ledger_append($1)',[db.event('stock_adjustment','opening_balance',id,buildOpeningBalanceLines({productId:id,quantity:50,unitCost:2}))]);
 const stale=(await db.admin.query('select to_jsonb(p) r from products p where id=$1',[id])).rows[0].r;stale.totalQuantity=stale.quantity;
 const receipt=(await c.query("select record_financial_command($1,$2,$3,'receipt',$4) r",[crypto.randomUUID(),db.store,db.device,{stockMirrorVersion:1,supplierId:supplier,paidAmount:0,wallet:'inStoreSafe',items:[{productId:id,variantName:'RED',quantity:10,unitCost:2}]}])).rows[0].r;
 const sold={productId:id,productName:'Synthetic',variantName:'RED',quantity:1,unitPrice:5,unitCost:2};
 const sale=(await c.query("select record_pos_sale($1,$2,$3,'pos_sale',$4) r",[crypto.randomUUID(),db.store,db.device,{kind:'sale',refType:'pos_sale',refId:crypto.randomUUID(),payload:{walletId:'inStoreSafe',items:[sold]},lines:buildSaleLines({items:[sold],wallet:'inStoreSafe'})}])).rows[0].r;
 const projected=applyMovesToProducts([stale],[{productId:id,variantName:'RED',delta:-1}]).products[0];
 const patch=stockMirrorPatch(projected);
 // Same authenticated absolute quantity/metadata UPDATE used by updateMirror
 // after normal POS commits. The existing API has no expected revision guard.
 const overwrite=()=>c.query('update products set quantity=$1,metadata=$2 where id=$3 and store_id=$4',[patch.totalQuantity,patch.metadata,id,db.store]);
 if(verify)await assert.rejects(overwrite,/NEXUS_STOCK_ATOMIC_REQUIRED/);else await overwrite();
 const persisted=(await db.admin.query('select quantity,metadata from products where id=$1',[id])).rows[0];
 const ledger=(await db.admin.query("select sum(qty_delta::numeric)::int quantity,sum(amount_delta)::int piastres from ledger_lines where store_id=$1 and account='stock' and subject_id=$2",[db.store,id])).rows[0];
 assert.equal(ledger.quantity,59);assert.equal(Number(persisted.quantity),verify?59:49);assert.equal(persisted.metadata.variants[0].stock,verify?39:29);
 const evidence={version:db.version,status:verify?'LOCAL_CORE_REGRESSION_PASS':'HISTORICAL_BASELINE_DEFECT_REPRODUCED',scope:'synthetic isolated only; candidate workflow coverage/release still incomplete; NOT Production verified',receiptId:receipt.eventId,saleId:sale.eventId,
  expected:{quantity:59,RED:39,BLUE:20},ledger,persisted,stale49:verify?'REJECTED':'ACCEPTED_ON_BASELINE'};
 fs.writeFileSync(path.join(ROOT,'logs/final-v1-sprint/'+(verify?'legacy-stock-mirror-candidate-regression.json':`legacy-stock-mirror-baseline-${Date.now()}.json`)),JSON.stringify(evidence,null,2));
 console.log(JSON.stringify(evidence,null,2));
}finally{await db.close()}
