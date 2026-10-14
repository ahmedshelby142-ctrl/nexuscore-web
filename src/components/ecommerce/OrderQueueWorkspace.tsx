import {useEffect,useRef,useState,type ReactNode} from "react";
import {MoreHorizontal,X} from "lucide-react";
import {Button} from "@/components/ui/button";
import {Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle} from "@/components/ui/dialog";
import {DropdownMenu,DropdownMenuTrigger,DropdownMenuContent,DropdownMenuItem} from "@/components/ui/dropdown-menu";

export interface OrderQueueEntry {
  id:string;number:string;customer:string;location:string;products:string;quantity:number;
  total:string;outstanding:string;collectionLabel?:string;status:ReactNode;badges:string[];
  actions?:{label:string;run:()=>void;disabled?:boolean}[];
}
/** One operational workspace, never one form per row. Business callbacks are
 * supplied by OrdersPage and retain their existing command/recovery contracts. */
export function OrderQueueWorkspace({entries,selectedId,onSelect,onClose,detail,title,status,suspended,empty,detailsOpen=true}:{
  entries:OrderQueueEntry[];selectedId:string|null;onSelect:(id:string)=>void;onClose:()=>void;
  detail:ReactNode;title:string;status:ReactNode;suspended:boolean;empty:ReactNode;detailsOpen?:boolean;
}) {
  const [wide,setWide]=useState(false),list=useRef<HTMLDivElement>(null),opener=useRef<HTMLElement|null>(null);
  useEffect(()=>{
    const media=window.matchMedia?.("(min-width:1280px)");
    const update=()=>setWide(media?media.matches:window.innerWidth>=1280);
    update();
    if(media?.addEventListener)media.addEventListener("change",update);else window.addEventListener("resize",update);
    return()=>{if(media?.removeEventListener)media.removeEventListener("change",update);else window.removeEventListener("resize",update);};
  },[]);
  const close=()=>{onClose();requestAnimationFrame(()=>{
    if(opener.current?.isConnected)opener.current.focus();
    else (list.current?.querySelector<HTMLButtonElement>("button[data-order-row]")??list.current)?.focus();
  });};
  const select=(id:string,element?:HTMLElement)=>{
    opener.current=element??[...list.current?.querySelectorAll<HTMLButtonElement>("button[data-order-row]")??[]].find(button=>button.dataset.orderRow===id)??null;
    onSelect(id);
  };
  const heading=<div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b bg-background p-4">
    <div className="min-w-0"><h2 className="break-all font-semibold" dir="ltr">{title}</h2>{status}</div>
    <Button variant="ghost" size="icon" aria-label="إغلاق تفاصيل الطلب" onClick={close}><X className="size-4"/></Button>
  </div>;
  return <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(24rem,1fr)]" dir="rtl" onKeyDown={e=>{
    if(wide&&selectedId&&detailsOpen&&!suspended&&e.key==="Escape"&&e.currentTarget.contains(e.target as Node))close();
  }}>
    <div ref={list} tabIndex={-1} aria-label="قائمة الطلبات" className="min-w-0 overflow-y-auto rounded-xl border bg-card xl:max-h-[calc(100dvh-14rem)]"
      onKeyDown={event=>{
        if(event.key!=="ArrowDown"&&event.key!=="ArrowUp")return;
        const buttons=[...list.current?.querySelectorAll<HTMLButtonElement>("button[data-order-row]")??[]];
        const current=buttons.indexOf(event.target as HTMLButtonElement);if(current<0)return;
        event.preventDefault();buttons[Math.max(0,Math.min(buttons.length-1,current+(event.key==="ArrowDown"?1:-1)))]?.focus();
      }}>
      {!entries.length?empty:entries.map(entry=><div key={entry.id} className={`flex min-h-16 max-h-[76px] items-center gap-1 border-b last:border-b-0 ${selectedId===entry.id?"bg-primary/10":""}`}>
        <button type="button" data-order-row={entry.id} aria-pressed={selectedId===entry.id}
          aria-label={`عرض الطلب ${entry.number} — ${entry.customer}`} className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] gap-x-3 p-3 text-right outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={event=>select(entry.id,event.currentTarget)}>
          <span className="min-w-0"><span className="flex min-w-0 gap-2"><strong className="max-w-[45%] truncate text-xs" dir="ltr" title={entry.number}>{entry.number}</strong><span className="truncate text-sm">{entry.customer}</span></span>
            <span className="block truncate text-xs text-muted-foreground" title={entry.products}>{entry.location} · {entry.quantity} وحدة/بوكس · {entry.products}</span>
            {entry.badges.length>0&&<span className="block truncate text-[10px] text-amber-700">{entry.badges.join(" · ")}</span>}
          </span>
          <span className="text-left text-xs"><span className="block">إجمالي {entry.total}</span><span className="block">{entry.collectionLabel||"المتبقي"} {entry.outstanding}</span>{entry.status}</span>
        </button>
        <DropdownMenu dir="rtl"><DropdownMenuTrigger asChild><Button size="icon" variant="ghost" aria-label={`إجراءات الطلب ${entry.number}`}><MoreHorizontal className="size-4"/></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end"><DropdownMenuItem onSelect={()=>select(entry.id)}>عرض التفاصيل والإجراءات</DropdownMenuItem>
            {entry.actions?.map(action=><DropdownMenuItem key={action.label} disabled={action.disabled} onSelect={()=>{select(entry.id);action.run();}}>{action.label}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>)}
    </div>
    {wide?<aside aria-label="تفاصيل الطلب" className="sticky top-4 min-w-0 self-start overflow-y-auto rounded-xl border bg-card xl:max-h-[calc(100dvh-14rem)]">
      {selectedId&&detailsOpen?<>{heading}<div className="space-y-4 p-4">{detail}</div></>:<p className="p-8 text-center text-muted-foreground">اختر طلبًا لعرض تفاصيله والإجراءات المتاحة.</p>}
    </aside>:<Dialog open={!!selectedId&&detailsOpen&&!suspended} onOpenChange={open=>{if(!open&&!suspended)close();}}>
      <DialogContent dir="rtl" className="left-auto right-0 top-0 h-[100dvh] max-h-[100dvh] w-screen max-w-none translate-x-0 translate-y-0 grid-rows-[auto_minmax(0,1fr)] gap-0 rounded-none p-0 sm:max-w-2xl sm:rounded-none [&>button]:hidden"
        onCloseAutoFocus={event=>{if(suspended)event.preventDefault();}}>
        <DialogHeader className="sr-only"><DialogTitle>تفاصيل الطلب {title}</DialogTitle><DialogDescription>تفاصيل العميل والمنتجات والحسابات والإجراءات الخاصة بالطلب المحدد.</DialogDescription></DialogHeader>
        {heading}<div className="min-h-0 space-y-4 overflow-y-auto p-4">{detail}</div>
      </DialogContent>
    </Dialog>}
  </div>;
}

export function OrderOperationPanel({title,summary,children,revision}:{title:string;summary:string;children:ReactNode;revision?:unknown}) {
  const [open,setOpen]=useState(false),dirty=useRef(false);
  useEffect(()=>{dirty.current=false;},[revision]);
  const changeOpen=(next:boolean)=>{
    if(!next&&dirty.current&&!window.confirm("توجد تعديلات غير محفوظة في هذه العملية. هل تريد إغلاقها وفقد المسودة؟"))return;
    dirty.current=false;setOpen(next);
  };
  return <div className="w-full rounded-lg border p-3 text-right">
    <p className="text-xs text-muted-foreground">{summary}</p>
    <Button variant="outline" size="sm" onClick={()=>changeOpen(true)}>{title}</Button>
    <Dialog open={open} onOpenChange={changeOpen}><DialogContent dir="rtl" className="sm:max-w-2xl max-h-[90dvh] overflow-y-auto" onChangeCapture={()=>{dirty.current=true;}}>
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{summary}</DialogDescription></DialogHeader>
      {open&&children}
    </DialogContent></Dialog>
  </div>;
}
