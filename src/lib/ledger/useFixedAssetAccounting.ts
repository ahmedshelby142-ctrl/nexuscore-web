import {useEffect,useState,useCallback} from "react";
import {readAccountingPosition,type AssetAccounting,type AccountingPosition} from "../fixedAssetAccounting";
import {useFinancialStore} from "@/store/useFinancialStore";
export function useFixedAssetAccounting() {
  const assets=useFinancialStore(s=>s.assets),[tick,setTick]=useState(0);
  const [data,setData]=useState<AssetAccounting|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState<string|null>(null);
  const [position,setPosition]=useState<AccountingPosition|null>(null);
  const refresh=useCallback(()=>setTick(t=>t+1),[]);
  useEffect(()=>{let active=true;setLoading(true);setData(null);setPosition(null);
    void readAccountingPosition().then(r=>{if(r.assetAccounting.reviewRequired)throw Error("تحتاج بيانات أصل قديم أو قيده إلى مراجعة.");if(active){setData(r.assetAccounting);setPosition(r);setError(null);}})
      .catch(e=>{if(active){setData(null);setPosition(null);setError(e instanceof Error?e.message:String(e));}})
      .finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[assets,tick]);
  useEffect(()=>{window.addEventListener("ledger-sync-pulled",refresh);return()=>window.removeEventListener("ledger-sync-pulled",refresh);},[refresh]);
  return {data,position,loading,error,refresh};
}
