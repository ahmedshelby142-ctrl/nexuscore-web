// Read-only SDK boundary backed by an authenticated disposable PostgreSQL client.
// Deliberately exposes no RPC/mutation method. Never accepts a connection string.
export function pgReadSdk(client,calls=[]) {
 return {from(table){if(!['ledger_events','ledger_lines'].includes(table))throw Error('Unexpected read table');
  const filters=[],params=[];let columns='*',from=0,to=999,sort='id';
  const identifier=s=>{if(!/^[a-z_]+$/.test(s))throw Error('Invalid test read identifier');return '"'+s+'"';};
  const execute=async(single=false)=>{calls.push({table,filters:[...filters],from,to,columns});try{const q='select '+columns+' from '+identifier(table)+(filters.length?' where '+filters.join(' and '):'')+' order by '+identifier(sort)+' limit '+(to-from+1)+' offset '+from;const result=await client.query(q,params);if(single&&result.rows.length>1)throw Error('Multiple rows');return {data:single?result.rows[0]??null:result.rows,error:null};}catch(error){return {data:null,error:{message:error.message}};}};
  const builder={select(value){columns=value.split(',').map(identifier).join(',');return this},eq(key,value){params.push(value);filters.push(identifier(key)+'=$'+params.length);return this},in(key,values){params.push(values);filters.push(identifier(key)+'=any($'+params.length+'::text[])');return this},order(key){sort=key;return this},range(a,b){if(!Number.isInteger(a)||!Number.isInteger(b)||a<0||b<a)throw Error('Invalid range');from=a;to=b;return this},maybeSingle(){return execute(true)},then(resolve,reject){return execute().then(resolve,reject)}};
  return builder;
 }};
}
