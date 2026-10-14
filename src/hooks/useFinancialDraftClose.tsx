import {useEffect,useRef,useState} from "react";
import {AlertDialog,AlertDialogContent,AlertDialogHeader,AlertDialogTitle,AlertDialogDescription,AlertDialogFooter,AlertDialogCancel,AlertDialogAction} from "@/components/ui/alert-dialog";
/** Explicit discard for controlled financial forms; successful commits close directly. */
export function useFinancialDraftClose({open,draft,busy,onClose}:{open:boolean;draft:unknown;busy:boolean;onClose:()=>void}) {
 const fingerprint=JSON.stringify(draft),baseline=useRef(fingerprint),wasOpen=useRef(false);
 const [asking,setAsking]=useState(false);
 useEffect(()=>{if(open&&!wasOpen.current)baseline.current=fingerprint;wasOpen.current=open;if(!open)setAsking(false);},[open,fingerprint]);
 useEffect(()=>{
  if(!open||fingerprint===baseline.current)return;
  const guard=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue="";};
  window.addEventListener("beforeunload",guard);return()=>window.removeEventListener("beforeunload",guard);
 },[open,fingerprint]);
 const close=()=>{if(busy)return;if(fingerprint!==baseline.current)setAsking(true);else onClose();};
 return {close,confirmation:<><span hidden data-pwa-unsaved={open&&wasOpen.current&&fingerprint!==baseline.current?"true":undefined}/>
 <AlertDialog open={asking} onOpenChange={setAsking}>
  <AlertDialogContent dir="rtl"><AlertDialogHeader><AlertDialogTitle>توجد مسودة مالية غير محفوظة</AlertDialogTitle>
   <AlertDialogDescription>لم تُرسل هذه التعديلات. احتفظ بالمسودة أو تجاهلها صراحةً؛ لا تُسجل هذه النافذة أي معاملة.</AlertDialogDescription></AlertDialogHeader>
   <AlertDialogFooter><AlertDialogCancel disabled={busy}>الاحتفاظ بالمسودة</AlertDialogCancel>
    <AlertDialogAction disabled={busy} onClick={()=>{if(!busy){setAsking(false);onClose();}}}>تجاهل المسودة</AlertDialogAction>
   </AlertDialogFooter>
  </AlertDialogContent>
 </AlertDialog></>};
}
