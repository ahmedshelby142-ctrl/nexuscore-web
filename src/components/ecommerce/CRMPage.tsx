import { useMemo, useState, useEffect } from "react";
import { formatMoney } from "@/lib/math";
import {
  Users,
  User,
  Phone,
  MapPin,
  ShoppingBag,
  Package,
  TrendingUp,
  Pencil,
  Trash2,
  UserPlus,
  Undo2,
  Archive,
  MessageCircle,
  Inbox,
  Search,
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { useCustomerStore } from "@/store/useCustomerStore";
import { activeCustomers, duplicateOf, isCustomerArchived, orderBelongsTo, deriveCustomerMetrics, type CustomerMetrics } from "@/lib/customers";
import { CustomerRemovalDialog } from "@/components/ecommerce/CustomerRemovalDialog";
import { useOrderStore } from "@/store/useOrderStore";
import { useBalances } from "@/lib/ledger/useBalances";
import { events } from "@/lib/ledger";
import type { LedgerEvent } from "@/lib/ledger";
import { toWhatsAppNumber } from "@/lib/phone";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { CustomerProfile } from "@/types";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** The blank form. One shape for both "register" and "correct". */
const EMPTY_FORM = { name: "", phone: "", address: "" };

export function CRMPage() {
  const { customers, addCustomer, updateCustomer, restoreCustomer } = useCustomerStore();
  const { orders } = useOrderStore();
  // LTV is SUM(customer_ltv) per customer id — the line every sale writes when
  // a customer is attached. The screen used to read a stored `lifetimeValue`
  // that only the e-commerce order path ever added to, so a POS sale to a
  // named customer wrote a real ledger line and this screen showed nothing.
  const { amountOf: ltvOf, error: ltvError } = useBalances("customer_ltv");
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  
  const [posSales, setPosSales] = useState<LedgerEvent[]>([]);
  useEffect(() => {
    let mounted = true;
    events({ kind: "sale" }).then(sales => {
      if (mounted) setPosSales(sales);
    }).catch(console.error);
    return () => { mounted = false; };
  }, []);

  // ── The directory the screen shows ──
  // Archived customers are hidden behind a toggle, exactly like المؤرشفين on
  // the partners screen. Their orders and LTV are untouched and still resolve
  // through `customerIdOf` — this only decides what is offered for NEW work.
  const [showArchived, setShowArchived] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const live = useMemo(() => activeCustomers(customers), [customers]);
  const archived = useMemo(() => customers.filter(isCustomerArchived), [customers]);
  
  const listed = useMemo(() => {
    let list = showArchived ? archived : live;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(c => c.name.toLowerCase().includes(q) || c.phone.includes(q));
    }
    return list;
  }, [showArchived, archived, live, searchQuery]);

  const selectedCustomer = useMemo(
    () => customers.find((customer) => customer.id === selectedCustomerId) || listed[0],
    [customers, selectedCustomerId, listed],
  );

  // ── Add / edit ──
  // `null` id = registering someone new; an id = correcting that row. The SAME
  // form serves both, the way the supplier dialog does, so a field added at
  // registration is editable the day it is added.
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [pendingRemoval, setPendingRemoval] = useState<CustomerProfile | null>(null);

  // Would saving this collide with someone else? The phone is the identity key
  // (§3.7), so letting two active rows share one would make every future match
  // permanently ambiguous — the duplicate problem, reintroduced by hand.
  const clash = useMemo(
    () => duplicateOf(customers, { phone: form.phone, name: form.name }, editingId ?? undefined),
    [customers, form.phone, form.name, editingId],
  );
  const canSave = form.name.trim().length > 0 && !clash;

  const openEditor = (customer?: CustomerProfile) => {
    setEditingId(customer?.id ?? null);
    setForm(
      customer
        ? { name: customer.name, phone: customer.phone, address: customer.address ?? "" }
        : EMPTY_FORM,
    );
    setEditorOpen(true);
  };

  const saveCustomer = async () => {
    if (!canSave) return;
    const fields = {
      name: form.name.trim(),
      phone: form.phone.trim(),
      address: form.address.trim(),
    };
    // Reference data, not a ledger event: correcting a spelling moves no
    // money. Past orders and every `customer_ltv` line keep pointing at this
    // customer by ID, so they follow the new name automatically.
    // Awaited: the editor stays open (and the typed values stay on screen)
    // until Supabase confirms. A failure toasts from the store and the dialog
    // does not close, instead of closing over a customer that was never saved.
    try {
      if (editingId) await updateCustomer(editingId, fields);
      else setSelectedCustomerId(await addCustomer(fields));
      setEditorOpen(false);
    } catch {
      /* the store already told the user; keep the form open to retry */
    }
  };

  // This customer's history. It used to be a raw `===` on the phone OR the
  // name, so a number stored as «+20 101…» and typed as «0101…» hid the order,
  // and any two customers sharing a first name saw each other's. Orders placed
  // since §3.7 carry the customer id; `orderBelongsTo` matches on that and
  // falls back to the phone key for the ones placed before.
  const timelineEvents = useMemo(() => {
    if (!selectedCustomer) return [];
    
    const ecOrders = orders.filter((order) => orderBelongsTo(order, selectedCustomer)).map(o => ({
      id: o.id,
      type: "ecommerce" as const,
      date: new Date(o.createdAt),
      displayId: o.orderNumber,
      status: o.status,
      totalAmount: o.totalAmount,
      expectedCod: o.expectedCod,
      originalData: o,
    }));
    
    const pos = posSales.filter(sale => (sale.payload as any)?.customerId === selectedCustomer.id).map(s => {
      const p = s.payload as any;
      const totalAmount = p.totalAmount || (p.items || []).reduce((acc: number, item: any) => acc + (item.quantity * item.unitPrice), 0);
      return {
        id: s.id,
        type: "pos" as const,
        date: new Date(s.occurredAt),
        displayId: "POS-" + (s.id.split("-")[0] || "").toUpperCase(),
        status: "delivered",
        totalAmount,
        expectedCod: 0,
        originalData: s,
      };
    });
    
    return [...ecOrders, ...pos].sort((a, b) => b.date.getTime() - a.date.getTime());
  }, [orders, posSales, selectedCustomer]);

  // Pre-calculate metrics for all listed customers so the table renders instantly
  const customerMetrics = useMemo(() => {
    const map = new Map();
    for (const c of listed) {
      map.set(c.id, deriveCustomerMetrics(c.id, orders, posSales));
    }
    return map;
  }, [listed, orders, posSales]);

  const selectedMetrics: CustomerMetrics = selectedCustomer
    ? customerMetrics.get(selectedCustomer.id) || deriveCustomerMetrics(selectedCustomer.id, orders, posSales)
    : { totalOrders: 0, preferredProducts: [], lastOrderAt: undefined };

  const [selectedTimelineOrder, setSelectedTimelineOrder] = useState<any | null>(null);

  const timelineOrderItems = useMemo(() => {
    if (!selectedTimelineOrder) return [];
    if (selectedTimelineOrder.type === "pos") {
      const payload = selectedTimelineOrder.originalData.payload;
      return (payload.items || payload.lines || []).map((i: any) => ({
        name: i.productName || i.name,
        quantity: i.quantity || i.qty || 1,
        unitPrice: i.unitPrice || 0,
        variantName: i.variantName,
        total: (i.quantity || i.qty || 1) * (i.unitPrice || 0)
      }));
    } else {
      return (selectedTimelineOrder.originalData.items || []).map((i: any) => ({
        name: i.productName || i.name,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        variantName: i.variantName,
        total: i.total || (i.quantity * i.unitPrice)
      }));
    }
  }, [selectedTimelineOrder]);

  return (
    <>
    <div className="space-y-6 print:hidden">
      <div>
        <h1 className="text-3xl font-display font-bold">قاعدة العملاء</h1>
        <p className="text-muted-foreground mt-1">
          CRM مغلق الحلقة: كل بيعة أو طلب باسم العميل بيزوّد الـ LTV بتاعه ويحدّث المنتجات المفضلة
        </p>
        {ltvError && (
          // A failed read must not render as 0 — that reads as a customer who
          // never bought anything.
          <p className="text-sm text-destructive mt-2">
            مقدرناش نقرأ إجمالي مشتريات العملاء من الدفتر، فالأرقام دي مش مضمونة. جرّب تاني.
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="rounded-2xl border border-border bg-card overflow-hidden">
          <div className="p-6 border-b flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="size-10 rounded-xl flex items-center justify-center bg-blue-100">
                <Users className="size-5 text-blue-600" />
              </div>
              <div>
                <h2 className="font-display text-xl font-bold">العملاء</h2>
                <p className="text-xs text-muted-foreground">{live.length} عميل</p>
              </div>
            </div>
            <Button size="sm" onClick={() => openEditor()}>
              <UserPlus className="size-4 ml-1.5" />
              عميل جديد
            </Button>
          </div>
          {archived.length > 0 && (
            <div className="px-6 py-2 border-b">
              <Button
                size="sm"
                variant={showArchived ? "default" : "ghost"}
                onClick={() => setShowArchived((v) => !v)}
              >
                <Archive className="size-3.5 ml-1.5" />
                المؤرشفين ({archived.length})
              </Button>
            </div>
          )}
          <div className="p-4 border-b">
            <Input 
              type="search" 
              placeholder="ابحث بالاسم أو رقم الهاتف..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="max-w-md"
            />
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right px-4">العميل</TableHead>
                <TableHead className="text-center px-4">الطلبات</TableHead>
                <TableHead className="text-center px-4">LTV</TableHead>
                <TableHead className="text-center px-4">آخر طلب</TableHead>
                <TableHead className="text-center px-4">إجراءات</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {listed.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-12">
                    {showArchived ? (
                      <EmptyState
                        icon={Inbox}
                        title="مفيش عملاء مؤرشفين"
                      />
                    ) : customers.length === 0 ? (
                      <EmptyState
                        icon={Inbox}
                        title="لسه مفيش عملاء"
                        description="بيتعمل كارت للعميل لوحده مع أول طلب، أو سجّليه بنفسك من عميل جديد."
                      />
                    ) : (
                      <EmptyState
                        icon={Search}
                        title="لا توجد نتائج مطابقة للبحث"
                      />
                    )}
                  </TableCell>
                </TableRow>
              ) : (
                listed.map((customer) => (
                  <TableRow
                    key={customer.id}
                    onClick={() => setSelectedCustomerId(customer.id)}
                    className="cursor-pointer"
                  >
                    <TableCell className="px-4">
                      <div className="font-medium flex items-center gap-2">
                        {customer.name}
                        {isCustomerArchived(customer) && (
                          <Badge variant="secondary">مؤرشف — له سجل سابق</Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">{customer.phone}</div>
                    </TableCell>
                    <TableCell className="text-center px-4 font-mono">
                      {customerMetrics.get(customer.id)?.totalOrders || 0}
                    </TableCell>
                    <TableCell className="text-center px-4 font-mono text-green-600">
                      {formatMoney(ltvOf(customer.id))}
                    </TableCell>
                    <TableCell className="text-center px-4 text-xs text-muted-foreground">
                      {customerMetrics.get(customer.id)?.lastOrderAt
                        ? new Date(customerMetrics.get(customer.id)!.lastOrderAt!).toLocaleDateString("ar-EG")
                        : "—"}
                    </TableCell>
                    {/* `stopPropagation`: the row itself selects the customer,
                        so without it every button would also change the
                        selection under the dialog that just opened. */}
                    <TableCell className="text-center px-4">
                      {isCustomerArchived(customer) ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={(e) => {
                            e.stopPropagation();
                            // The store announces its own failure; this only
                            // stops the rejection going unhandled.
                            void restoreCustomer(customer.id).catch(() => {});
                          }}
                        >
                          <Undo2 className="size-3.5 ml-1.5" />
                          استرجاع
                        </Button>
                      ) : (
                        <div className="flex items-center justify-center gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label="تعديل بيانات العميل"
                            onClick={(e) => {
                              e.stopPropagation();
                              openEditor(customer);
                            }}
                          >
                            <Pencil className="size-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label="مسح العميل"
                            onClick={(e) => {
                              e.stopPropagation();
                              setPendingRemoval(customer);
                            }}
                          >
                            <Trash2 className="size-4 text-destructive" />
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <div className="lg:col-span-2 space-y-6">
          {selectedCustomer ? (
            <>
              <div className="rounded-2xl border border-border bg-card p-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <div className="size-12 rounded-xl flex items-center justify-center bg-primary/10">
                      <User className="size-6 text-primary" />
                    </div>
                    <div>
                      <h2 className="font-display text-2xl font-bold">{selectedCustomer.name}</h2>
                      <div className="flex items-center gap-3 text-sm text-muted-foreground mt-2">
                        <span className="flex items-center gap-1">
                          <Phone className="size-4" />
                          {selectedCustomer.phone}
                          {toWhatsAppNumber(selectedCustomer.phone) && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-6 text-green-600 hover:text-green-700 hover:bg-green-50 rounded-full"
                              onClick={(e) => {
                                e.stopPropagation();
                                window.open(`https://wa.me/${toWhatsAppNumber(selectedCustomer.phone)}`, "_blank", "noreferrer");
                              }}
                              title="مراسلة واتساب"
                            >
                              <MessageCircle className="size-4" />
                            </Button>
                          )}
                        </span>
                        <span className="flex items-center gap-1">
                          <MapPin className="size-4" />
                          {selectedCustomer.address}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="text-left flex items-start gap-3">
                    <div>
                      <p className="text-xs text-muted-foreground">LTV</p>
                      <p className="text-2xl font-bold text-green-600">
                        {formatMoney(ltvOf(selectedCustomer.id))}
                      </p>
                    </div>
                    {!isCustomerArchived(selectedCustomer) && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openEditor(selectedCustomer)}
                      >
                        <Pencil className="size-3.5 ml-1.5" />
                        تعديل
                      </Button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6">
                  <div className="rounded-xl border bg-muted/30 p-4">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <ShoppingBag className="size-4" />
                      إجمالي الطلبات
                    </div>
                    <p className="text-2xl font-bold mt-2">{selectedMetrics.totalOrders}</p>
                  </div>
                  <div className="rounded-xl border bg-muted/30 p-4">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <TrendingUp className="size-4" />
                      متوسط قيمة الطلب
                    </div>
                    <p className="text-2xl font-bold mt-2">
                      {formatMoney(
                        selectedMetrics.totalOrders
                          ? ltvOf(selectedCustomer.id) / selectedMetrics.totalOrders
                          : 0,
                      )}
                    </p>
                  </div>
                  <div className="rounded-xl border bg-muted/30 p-4">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Package className="size-4" />
                      أكثر منتج طلباً
                    </div>
                    <p className="text-lg font-bold mt-2 truncate">
                      {selectedMetrics.preferredProducts[0]?.name || "—"}
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-border bg-card p-6">
                <h3 className="font-display text-xl font-bold mb-4">المنتجات المفضلة</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {selectedMetrics.preferredProducts.length === 0 ? (
                    <p className="text-sm text-muted-foreground">لا توجد منتجات مفضلة بعد</p>
                  ) : (
                    selectedMetrics.preferredProducts.map((product) => (
                      <div
                        key={product.productId}
                        className="rounded-xl border bg-muted/30 p-4 flex items-center justify-between gap-3"
                      >
                        <div>
                          <p className="font-medium">{product.name}</p>
                          <p className="text-xs text-muted-foreground">
                            تم طلبه {product.quantity} مرة
                          </p>
                        </div>
                        <Badge variant="outline">{formatMoney(product.spent)}</Badge>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-border bg-card overflow-hidden">
                <div className="p-6 border-b">
                  <h3 className="font-display text-xl font-bold">timeline الطلبات</h3>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-right px-4">رقم الطلب</TableHead>
                      <TableHead className="text-center px-4">التاريخ</TableHead>
                      <TableHead className="text-center px-4">الحالة</TableHead>
                      <TableHead className="text-center px-4">الإجمالي</TableHead>
                      <TableHead className="text-center px-4">COD</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {timelineEvents.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="py-12">
                          <EmptyState
                            icon={Inbox}
                            title="لا توجد طلبات لهذا العميل"
                          />
                        </TableCell>
                      </TableRow>
                    ) : (
                      timelineEvents.map((event) => (
                        <TableRow 
                          key={event.id}
                          onClick={() => setSelectedTimelineOrder(event)}
                          className="cursor-pointer hover:bg-muted/50 transition-colors"
                        >
                          <TableCell className="px-4 font-mono flex items-center gap-2">
                            {event.displayId}
                            {event.type === "pos" ? (
                              <Badge variant="outline" className="ml-2 text-[10px]">شراء من المحل</Badge>
                            ) : (
                              <Badge variant="outline" className="ml-2 text-[10px] text-blue-600 border-blue-200 bg-blue-50">طلب أونلاين</Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-center px-4 text-sm text-muted-foreground">
                            {event.date.toLocaleString("ar-EG")}
                          </TableCell>
                          <TableCell className="text-center px-4">
                            {event.type === "pos" ? (
                              <Badge variant="default">مكتمل</Badge>
                            ) : (
                              <Badge
                                variant={
                                  event.status === "delivered"
                                    ? "default"
                                    : event.status === "returned"
                                      ? "destructive"
                                      : "secondary"
                                }
                              >
                                {event.status}
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-center px-4 font-mono">
                            {formatMoney(event.totalAmount)}
                          </TableCell>
                          <TableCell className="text-center px-4 font-mono text-amber-600">
                            {event.expectedCod > 0 ? formatMoney(event.expectedCod) : "-"}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </>
          ) : (
            <div className="rounded-2xl border border-border bg-card p-12">
              <EmptyState
                icon={Users}
                title="لا يوجد عملاء لعرضهم"
                description="اختر عميلاً من القائمة أو أضف عميلاً جديداً"
              />
            </div>
          )}
        </div>
      </div>

      {/* ── Register / correct a customer ────────────────────────────────
          One dialog for both, like the supplier editor. A reference write:
          nothing here appends to the ledger, because nothing here moves
          money. Past orders follow the new name automatically — they point
          at the customer by id, not by the text that was typed on them. */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingId ? "تعديل بيانات العميل" : "عميل جديد"}</DialogTitle>
            <DialogDescription>
              {editingId
                ? "تصحيح الاسم أو الرقم أو العنوان. الطلبات وإجمالي المشتريات المسجّلة قبل كده مش هتتغيّر — هي مربوطة بالعميل نفسه، مش باسمه أو رقمه."
                : "سجّلي العميل بنفسك من غير ما تستني أول طلب."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="cust-name">الاسم *</Label>
              <Input
                id="cust-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="اسم العميل"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cust-phone">رقم الهاتف</Label>
              <Input
                id="cust-phone"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="01xxxxxxxxx"
              />
              <p className="text-xs text-muted-foreground">
                الرقم هو اللي بنعرف بيه العميل، فالطلب الجاي من نفس الرقم بيروح على نفس الكارت.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cust-address">العنوان</Label>
              <Input
                id="cust-address"
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                placeholder="المحافظة / العنوان"
              />
            </div>
            {/* The guard that keeps one number on one card. Without it the
                owner can hand two active rows the same identity, and from then
                on every match is ambiguous for ever. */}
            {clash && (
              <p className="text-sm text-destructive">
                {form.phone.trim()
                  ? `الرقم ده متسجل بالفعل باسم «${clash.name}». عدّلي على الكارت بتاعه بدل ما تعملي كارت تاني بنفس الرقم.`
                  : `فيه عميل مسجل بنفس الاسم «${clash.name}» ومن غير رقم. اكتبي رقم تليفون عشان نفرّق بينهم، أو عدّلي على كارته.`}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditorOpen(false)}>
              إلغاء
            </Button>
            <Button onClick={saveCustomer} disabled={!canSave}>
              {editingId ? "حفظ التعديلات" : "إضافة العميل"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Archive-if-has-history, the same question المنتجات and الشركاء ask. */}
      <CustomerRemovalDialog
        customer={pendingRemoval}
        onClose={() => setPendingRemoval(null)}
        onRemoved={() => setSelectedCustomerId("")}
      />
    </div>

    <Dialog open={!!selectedTimelineOrder} onOpenChange={(open) => !open && setSelectedTimelineOrder(null)}>
      {/* We use print:[&>button]:hidden to hide the Shadcn close (X) button during print. */}
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto print:[&>button]:hidden">
        <DialogHeader className="print:hidden">
          <DialogTitle>
            تفاصيل الطلب: {selectedTimelineOrder?.displayId}
            {selectedTimelineOrder?.type === "pos" ? " (شراء من المحل)" : " (طلب أونلاين)"}
          </DialogTitle>
          <DialogDescription>
            التاريخ: {selectedTimelineOrder?.date?.toLocaleString("ar-EG")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">المنتج</TableHead>
                <TableHead className="text-center">الدرجة / النوع</TableHead>
                <TableHead className="text-center">الكمية</TableHead>
                <TableHead className="text-center">سعر الوحدة</TableHead>
                <TableHead className="text-left">الإجمالي</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {timelineOrderItems.map((item: any, i: number) => (
                <TableRow key={i}>
                  <TableCell className="font-medium text-right">{item.name}</TableCell>
                  <TableCell className="text-center text-muted-foreground">{item.variantName || "—"}</TableCell>
                  <TableCell className="text-center">{item.quantity}</TableCell>
                  <TableCell className="text-center">{formatMoney(item.unitPrice)}</TableCell>
                  <TableCell className="text-left font-mono">{formatMoney(item.total)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          
          <div className="flex justify-between items-center bg-muted/30 p-4 rounded-xl border border-border">
            <span className="font-bold">الإجمالي الكلي:</span>
            <span className="font-bold text-lg font-mono text-green-600">{formatMoney(selectedTimelineOrder?.totalAmount || 0)}</span>
          </div>

          <div className="flex justify-end pt-2 print:hidden">
            <Button onClick={() => { setTimeout(() => window.print(), 100); }}>
              طباعة الإيصال (PDF)
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>

    {selectedTimelineOrder && (
      <div className="hidden print:block absolute top-0 left-0 w-full min-h-screen bg-white text-black p-8 z-[99999]" dir="rtl">
        <div className="text-center mb-8 border-b-2 border-black pb-4">
          <h1 className="text-3xl font-bold mb-2">فاتورة مبيعات</h1>
          <p className="text-gray-600">{selectedTimelineOrder.type === "pos" ? "شراء من المحل" : "طلب أونلاين"}</p>
        </div>
        
        <div className="flex justify-between mb-8">
          <div>
            <p className="font-bold text-lg mb-1">بيانات العميل:</p>
            <p>الاسم: {selectedCustomer?.name}</p>
            <p>رقم الهاتف: {selectedCustomer?.phone}</p>
          </div>
          <div className="text-left">
            <p className="font-bold text-lg mb-1">بيانات الطلب:</p>
            <p>رقم الطلب: {selectedTimelineOrder.displayId}</p>
            <p>التاريخ: {selectedTimelineOrder.date.toLocaleString("ar-EG")}</p>
          </div>
        </div>

        <table className="w-full text-right border-collapse mb-8">
          <thead>
            <tr className="border-b-2 border-black">
              <th className="py-2">المنتج</th>
              <th className="py-2 text-center">الدرجة</th>
              <th className="py-2 text-center">الكمية</th>
              <th className="py-2 text-center">السعر</th>
              <th className="py-2 text-left">الإجمالي</th>
            </tr>
          </thead>
          <tbody>
            {timelineOrderItems.map((item: any, i: number) => (
              <tr key={i} className="border-b border-gray-300">
                <td className="py-2 font-medium">{item.name}</td>
                <td className="py-2 text-center text-gray-600">{item.variantName || "-"}</td>
                <td className="py-2 text-center">{item.quantity}</td>
                <td className="py-2 text-center">{item.unitPrice.toLocaleString("ar-EG")}</td>
                <td className="py-2 text-left font-mono">{item.total.toLocaleString("ar-EG")}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="flex justify-between items-center border-t-2 border-black pt-4">
          <p className="text-xl font-bold">الإجمالي الكلي:</p>
          <p className="text-2xl font-bold font-mono">{selectedTimelineOrder.totalAmount.toLocaleString("ar-EG")} ج.م</p>
        </div>
        
        <div className="mt-12 text-center text-gray-500 text-sm">
          <p>شكراً لتعاملكم معنا</p>
        </div>
      </div>
    )}
    </>
  );
}
