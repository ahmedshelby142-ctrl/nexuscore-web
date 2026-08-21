import { useState, useMemo } from "react";
import { formatMoney } from "@/lib/math";
import { useDraftState, clearDrafts } from "@/hooks/useDraftState";
import { productWholesalePrice } from "@/lib/product";
import { format } from "date-fns";
import {
  FileSpreadsheet,
  Users,
  Plus,
  DollarSign,
  CalendarDays,
  Search,
  Receipt,
  Building2,
  Phone,
  Clock,
  Landmark,
  CheckCircle2,
  X,
  Trash2,
  Printer,
  AlertCircle,
  Loader2,
  Inbox,
} from "lucide-react";
import { toast } from "sonner";
import { useBusinessStore } from "@/store/useBusinessStore";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { ShippingSelector } from "@/components/shipping/ShippingSelector";
import { printTableAsPdf } from "@/lib/pdfGenerator";
import { appendEvent } from "@/lib/ledger";
import { buildWholesaleInvoiceLines, buildClientPaymentLines } from "@/lib/ledger/wholesale";
import { useStock } from "@/lib/ledger/useStock";
import { useBalances } from "@/lib/ledger/useBalances";
import type { WholesaleInvoiceItem, ShippingInfo, WalletType } from "@/types";
import { WALLET_LABELS } from "@/types";

type Tab = "invoices" | "clients";

const emptyInvoiceForm = {
  clientId: "",
  paidAmount: 0,
  dueDate: "",
  notes: "",
  wallet: "inStoreSafe" as WalletType,
};

function getInvoiceStatus(
  status: string,
  dueDate: string,
  remaining: number,
): { label: string; variant: "default" | "secondary" | "destructive" | "outline" } {
  if (remaining <= 0) return { label: "مدفوع", variant: "default" };
  if (status === "overdue" || (dueDate && new Date(dueDate) < new Date()))
    return { label: "متأخر", variant: "destructive" };
  if (remaining < 0) return { label: "مدفوع", variant: "default" };
  return { label: "متبقي " + formatMoney(remaining), variant: "secondary" };
}

export function WholesalePage() {
  const {
    products,
    wholesaleClients,
    wholesaleInvoices,
    addWholesaleClient,
    addWholesaleInvoice,
    recordWholesalePayment,
  } = useBusinessStore();

  const { qtyOf, costOf, refresh: refreshStock } = useStock();

  const {
    amountOf: debtOf,
    total: totalReceivables,
    error: debtError,
    refresh: refreshDebt,
  } = useBalances("receivable_client");

  const [activeTab, setActiveTab] = useState<Tab>("invoices");
  const [searchQuery, setSearchQuery] = useState("");

  const [isInvoiceOpen, setIsInvoiceOpen] = useDraftState("wholesale:invoiceOpen", false);
  const [invoiceForm, setInvoiceForm] = useDraftState("wholesale:invoiceForm", emptyInvoiceForm);
  const [invoiceItems, setInvoiceItems] = useDraftState<WholesaleInvoiceItem[]>(
    "wholesale:invoiceItems",
    [],
  );
  const [selectedProductId, setSelectedProductId] = useState("");
  const [itemQty, setItemQty] = useState(1);
  const [shippingInfo, setShippingInfo] = useDraftState<ShippingInfo>("wholesale:shipping", {
    requiresShipping: false,
    customerCharge: 0,
    actualCost: 0,
  });

  const [isNewClientOpen, setIsNewClientOpen] = useState(false);
  const [newClientForm, setNewClientForm] = useDraftState("wholesale:newClient", {
    companyName: "",
    contactPerson: "",
    phone: "",
    email: "",
  });

  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);

  const [isPaymentOpen, setIsPaymentOpen] = useState(false);
  const [paymentInvoiceId, setPaymentInvoiceId] = useState<string | null>(null);
  const [paymentAmount, setPaymentAmount] = useState(0);
  const [paymentWallet, setPaymentWallet] = useState<WalletType>("inStoreSafe");
  const [isPaying, setIsPaying] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);

  const stats = useMemo(() => {
    const totalRevenue = wholesaleInvoices.reduce((s, i) => s + i.totalAmount, 0);
    const activeClients = wholesaleClients.length;
    return { totalRevenue, activeClients };
  }, [wholesaleInvoices, wholesaleClients]);

  const clientTotals = useMemo(() => {
    const totals = new Map<string, { invoiced: number; paid: number }>();
    for (const inv of wholesaleInvoices) {
      const acc = totals.get(inv.clientId) ?? { invoiced: 0, paid: 0 };
      acc.invoiced += inv.totalAmount;
      acc.paid += inv.paidAmount;
      totals.set(inv.clientId, acc);
    }
    return totals;
  }, [wholesaleInvoices]);

  const totalsOf = (clientId: string) =>
    clientTotals.get(clientId) ?? { invoiced: 0, paid: 0 };

  const selectedProduct = products.find((p) => p.id === selectedProductId);
  const paymentInvoice = wholesaleInvoices.find((i) => i.id === paymentInvoiceId);

  const invoiceTotal = useMemo(
    () =>
      invoiceItems.reduce((s, i) => s + i.total, 0) +
      (shippingInfo.requiresShipping ? shippingInfo.customerCharge : 0),
    [invoiceItems, shippingInfo],
  );
  const remainingAfterPaid = Math.max(0, invoiceTotal - invoiceForm.paidAmount);

  function resetInvoiceForm() {
    clearDrafts("wholesale:");
    setInvoiceForm(emptyInvoiceForm);
    setInvoiceItems([]);
    setSelectedProductId("");
    setItemQty(1);
    setShippingInfo({ requiresShipping: false, customerCharge: 0, actualCost: 0 });
  }

  function openInvoiceModal() {
    resetInvoiceForm();
    setIsInvoiceOpen(true);
  }

  function addItemToInvoice() {
    if (!selectedProduct) return;
    const existing = invoiceItems.find((i) => i.productId === selectedProduct.id);
    if (existing) {
      setInvoiceItems(
        invoiceItems.map((i) =>
          i.productId === selectedProduct.id
            ? {
                ...i,
                quantity: i.quantity + itemQty,
                total: (i.quantity + itemQty) * i.wholesalePrice,
              }
            : i,
        ),
      );
    } else {
      setInvoiceItems([
        ...invoiceItems,
        {
          id: crypto.randomUUID(),
          productId: selectedProduct.id,
          productName: selectedProduct.name,
          sku: selectedProduct.sku,
          quantity: itemQty,
          wholesalePrice: productWholesalePrice(selectedProduct),
          total: itemQty * productWholesalePrice(selectedProduct),
        },
      ]);
    }
    setSelectedProductId("");
    setItemQty(1);
  }

  function removeInvoiceItem(productId: string) {
    setInvoiceItems(invoiceItems.filter((i) => i.productId !== productId));
  }

  async function submitInvoice() {
    if (!invoiceForm.clientId || invoiceItems.length === 0) return;
    const client = wholesaleClients.find((c) => c.id === invoiceForm.clientId);
    if (!client) return;
    const invNum = "FJ-" + String(wholesaleInvoices.length + 1).padStart(4, "0");

    const short = invoiceItems.find((i) => i.quantity > qtyOf(i.productId));
    if (short) {
      toast.error(
        `الكمية المطلوبة من "${short.productName}" أكبر من المخزون (${qtyOf(short.productId)})`,
      );
      return;
    }

    setIsSubmitting(true);

    try {
      await appendEvent({
        kind: "sale",
        actor: "جملة",
        refType: "wholesale_invoice",
        refId: invNum,
        payload: {
          invoiceNumber: invNum,
          clientName: client.companyName,
          channel: "wholesale",
          itemCount: invoiceItems.length,
        },
        lines: buildWholesaleInvoiceLines({
          items: invoiceItems.map((i) => ({
            productId: i.productId,
            quantity: i.quantity,
            unitPrice: i.wholesalePrice,
            unitCost: costOf(i.productId),
          })),
          clientId: invoiceForm.clientId,
          wallet: invoiceForm.wallet,
          paidAmount: invoiceForm.paidAmount,
          shippingCharge: shippingInfo.requiresShipping ? shippingInfo.customerCharge : 0,
          shippingCost: shippingInfo.requiresShipping ? shippingInfo.actualCost : 0,
        }),
      });
    } catch (e) {
      toast.error(`الفاتورة متسجلتش والمخزون زي ما هو. ${e instanceof Error ? e.message : String(e)}`);
      setIsSubmitting(false);
      return;
    }

    addWholesaleInvoice({
      invoiceNumber: invNum,
      clientId: invoiceForm.clientId,
      clientName: client.companyName,
      items: invoiceItems,
      totalAmount: invoiceTotal,
      paidAmount: invoiceForm.paidAmount,
      remainingAmount: remainingAfterPaid,
      dueDate: invoiceForm.dueDate,
      status:
        invoiceForm.paidAmount >= invoiceTotal
          ? "paid"
          : invoiceForm.paidAmount > 0
            ? "partial"
            : "unpaid",
      notes: invoiceForm.notes || undefined,
    });

    refreshStock();
    refreshDebt();
    setIsSubmitting(false);
    setIsInvoiceOpen(false);
    resetInvoiceForm();
  }

  function openPayment(invoiceId: string) {
    setPaymentInvoiceId(invoiceId);
    setPaymentAmount(0);
    setPaymentWallet("inStoreSafe");
    setIsPaymentOpen(true);
  }

  async function submitPayment() {
    if (!paymentInvoiceId || paymentAmount <= 0) return;
    const invoice = wholesaleInvoices.find((i) => i.id === paymentInvoiceId);
    if (!invoice) return;

    setIsPaying(true);

    try {
      await appendEvent({
        kind: "client_payment",
        actor: "جملة",
        refType: "wholesale_invoice",
        refId: invoice.invoiceNumber,
        payload: {
          invoiceNumber: invoice.invoiceNumber,
          clientName: invoice.clientName,
        },
        lines: buildClientPaymentLines({
          clientId: invoice.clientId,
          wallet: paymentWallet,
          amount: paymentAmount,
        }),
      });
    } catch (e) {
      toast.error(
        `لم تُسجَّل الدفعة ولم يتغيّر أي رصيد. ${e instanceof Error ? e.message : String(e)}`,
      );
      setIsPaying(false);
      return;
    }

    recordWholesalePayment(paymentInvoiceId, paymentAmount);
    refreshDebt();
    setIsPaying(false);
    setIsPaymentOpen(false);
    setPaymentInvoiceId(null);
  }

  const selectedClientInvoices = wholesaleInvoices.filter((i) => i.clientId === selectedClientId);
  const selectedClientData = wholesaleClients.find((c) => c.id === selectedClientId);

  const filteredInvoices = useMemo(() => {
    if (!searchQuery.trim()) return wholesaleInvoices;
    const q = searchQuery.toLowerCase();
    return wholesaleInvoices.filter(
      (i) => i.invoiceNumber.toLowerCase().includes(q) || i.clientName.toLowerCase().includes(q),
    );
  }, [wholesaleInvoices, searchQuery]);

  const filteredClients = useMemo(() => {
    if (!searchQuery.trim()) return wholesaleClients;
    const q = searchQuery.toLowerCase();
    return wholesaleClients.filter(
      (c) =>
        c.companyName.toLowerCase().includes(q) ||
        c.contactPerson.toLowerCase().includes(q) ||
        c.phone.includes(q),
    );
  }, [wholesaleClients, searchQuery]);

  const handleExportPdf = () => {
    if (activeTab === "invoices") {
      printTableAsPdf({
        title: "فواتير الجملة",
        subtitle: `حتى ${format(new Date(), "dd/MM/yyyy")}`,
        columns: [
          { label: "رقم الفاتورة", accessor: (i) => i.invoiceNumber },
          { label: "العميل", accessor: (i) => i.clientName },
          { label: "التاريخ", accessor: (i) => format(new Date(i.createdAt), "dd/MM/yyyy") },
          { label: "الإجمالي", accessor: (i) => formatMoney(i.totalAmount), align: "center" },
          { label: "المدفوع", accessor: (i) => formatMoney(i.paidAmount), align: "center" },
          { label: "المتبقي", accessor: (i) => formatMoney(i.remainingAmount), align: "center" },
        ],
        rows: filteredInvoices,
        footer: `إجمالي الفواتير: ${filteredInvoices.length} — قيمة: ${formatMoney(
          filteredInvoices.reduce((s, i) => s + i.totalAmount, 0),
        )}`,
      });
    } else {
      printTableAsPdf({
        title: "عملاء الجملة",
        columns: [
          { label: "اسم الشركة", accessor: (c) => c.companyName },
          { label: "المسؤول", accessor: (c) => c.contactPerson },
          { label: "الهاتف", accessor: (c) => c.phone, align: "center" },
          { label: "إجمالي مفوتر", accessor: (c) => formatMoney(totalsOf(c.id).invoiced), align: "center" },
          { label: "مدفوع", accessor: (c) => formatMoney(totalsOf(c.id).paid), align: "center" },
          { label: "متبقي", accessor: (c) => formatMoney(debtOf(c.id)), align: "center" },
        ],
        rows: filteredClients,
        footer: `إجمالي العملاء: ${filteredClients.length}`,
      });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold">مبيعات الجملة والعملاء</h1>
          <p className="text-muted-foreground mt-1">إدارة فواتير الجملة وحسابات العملاء</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" onClick={handleExportPdf} className="gap-2 h-10 px-5">
            <Printer className="size-4" />
            تصدير PDF
          </Button>
          {activeTab === "invoices" && (
            <Button onClick={openInvoiceModal} className="gap-2 h-10 px-5">
              <Plus className="size-4" />
              إنشاء فاتورة جملة
            </Button>
          )}
        </div>
      </div>

      {debtError && (
        <div className="rounded-xl p-4 flex items-start gap-3 bg-red-50 border border-red-200">
          <AlertCircle className="size-5 text-red-600 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold text-red-900">تعذّرت قراءة مديونيات العملاء</p>
            <p className="text-sm text-red-800 mt-1">
              الأرقام المعروضة مش موثوقة — متحصّلش قبل ما ده يتصلّح. {debtError}
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
        <Card className="overflow-hidden">
          <CardContent className="p-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs tracking-wider text-muted-foreground">إيرادات الجملة</p>
                <p className="font-display text-3xl font-semibold mt-2">
                  {formatMoney(stats.totalRevenue)}
                </p>
              </div>
              <div
                className="size-10 rounded-xl flex items-center justify-center"
                style={{
                  backgroundColor: "color-mix(in oklab, var(--chart-1) 15%, transparent)",
                  color: "var(--chart-1)",
                }}
              >
                <Landmark className="size-5" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="overflow-hidden">
          <CardContent className="p-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs tracking-wider text-muted-foreground">الديون المستحقة</p>
                <p className="font-display text-3xl font-semibold mt-2">
                  {formatMoney(totalReceivables)}
                </p>
              </div>
              <div
                className="size-10 rounded-xl flex items-center justify-center"
                style={{
                  backgroundColor: "color-mix(in oklab, #f59e0b 15%, transparent)",
                  color: "#f59e0b",
                }}
              >
                <Receipt className="size-5" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="overflow-hidden">
          <CardContent className="p-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs tracking-wider text-muted-foreground">العملاء النشطون</p>
                <p className="font-display text-3xl font-semibold mt-2">{stats.activeClients}</p>
              </div>
              <div
                className="size-10 rounded-xl flex items-center justify-center"
                style={{
                  backgroundColor: "color-mix(in oklab, var(--chart-2) 15%, transparent)",
                  color: "var(--chart-2)",
                }}
              >
                <Building2 className="size-5" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex gap-2 border-b border-border pb-0">
        <button
          onClick={() => {
            setActiveTab("invoices");
            setSearchQuery("");
            setSelectedClientId(null);
          }}
          className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "invoices"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <FileSpreadsheet className="size-4 inline ml-1.5" />
          فواتير الجملة
        </button>
        <button
          onClick={() => {
            setActiveTab("clients");
            setSearchQuery("");
            setSelectedClientId(null);
          }}
          className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "clients"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <Users className="size-4 inline ml-1.5" />
          دليل العملاء والآجل
        </button>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <Input
          placeholder={
            activeTab === "invoices"
              ? "بحث برقم الفاتورة أو اسم العميل..."
              : "بحث باسم الشركة أو رقم الهاتف..."
          }
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pr-9"
        />
      </div>

      {activeTab === "invoices" && (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right px-4">رقم الفاتورة</TableHead>
                  <TableHead className="text-center px-4">العميل</TableHead>
                  <TableHead className="text-center px-4">الإجمالي</TableHead>
                  <TableHead className="text-center px-4">المدفوع</TableHead>
                  <TableHead className="text-center px-4">المتبقي</TableHead>
                  <TableHead className="text-center px-4">تاريخ الاستحقاق</TableHead>
                  <TableHead className="text-center px-4">الحالة</TableHead>
                  <TableHead className="text-center px-4">إجراءات</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredInvoices.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-12">
                      <EmptyState
                        icon={searchQuery ? Search : Inbox}
                        title={searchQuery ? "لا توجد نتائج مطابقة للبحث" : "مفيش فواتير جملة"}
                        description={searchQuery ? "جرب بحث تاني" : "الفواتير اللي هتسجلها هتظهر هنا"}
                      />
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredInvoices.map((inv) => {
                    const st = getInvoiceStatus(inv.status, inv.dueDate, inv.remainingAmount);
                    const isOverdue = st.variant === "destructive";
                    return (
                      <TableRow key={inv.id} className={isOverdue ? "bg-red-50/50" : ""}>
                        <TableCell className="font-mono text-xs font-medium px-4 whitespace-nowrap">
                          {inv.invoiceNumber}
                        </TableCell>
                        <TableCell className="text-center px-4 whitespace-nowrap">
                          {inv.clientName}
                        </TableCell>
                        <TableCell className="text-center px-4 whitespace-nowrap">
                          {formatMoney(inv.totalAmount)}
                        </TableCell>
                        <TableCell className="text-center px-4 whitespace-nowrap">
                          {formatMoney(inv.paidAmount)}
                        </TableCell>
                        <TableCell
                          className={
                            "text-center px-4 whitespace-nowrap" +
                            (inv.remainingAmount > 0 ? " font-semibold text-amber-600" : "")
                          }
                        >
                          {formatMoney(inv.remainingAmount)}
                        </TableCell>
                        <TableCell className="text-center px-4 whitespace-nowrap text-sm">
                          {inv.dueDate ? new Date(inv.dueDate).toLocaleDateString("ar-EG") : "—"}
                        </TableCell>
                        <TableCell className="text-center px-4">
                          <Badge variant={st.variant}>{st.label}</Badge>
                        </TableCell>
                        <TableCell className="text-center px-4">
                          <div className="flex items-center justify-center">
                            {inv.remainingAmount > 0 && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 text-xs"
                                onClick={() => openPayment(inv.id)}
                              >
                                <DollarSign className="size-3 ml-1" />
                                تسجيل دفعة
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {activeTab === "clients" && (
        <div className="grid grid-cols-1 gap-6">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-right px-4">اسم الشركة</TableHead>
                    <TableHead className="text-center px-4">جهة الاتصال</TableHead>
                    <TableHead className="text-center px-4">رقم الهاتف</TableHead>
                    <TableHead className="text-center px-4">إجمالي الفواتير</TableHead>
                    <TableHead className="text-center px-4">المدفوع</TableHead>
                    <TableHead className="text-center px-4">المتبقي</TableHead>
                    <TableHead className="text-center px-4">حالة الحساب</TableHead>
                    <TableHead className="text-center px-4">الإجراءات</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredClients.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="py-12">
                        <EmptyState
                          icon={searchQuery ? Search : Inbox}
                          title={searchQuery ? "لا توجد نتائج مطابقة للبحث" : "مفيش عملاء متسجلين"}
                          description={searchQuery ? "جرب بحث تاني" : "ابدأ بإضافة عميل جديد"}
                        />
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredClients.map((client) => {
                      const owed = debtOf(client.id);
                      const { invoiced, paid } = totalsOf(client.id);
                      const hasDebt = owed > 0;
                      const hasOverdue = wholesaleInvoices.some(
                        (i) =>
                          i.clientId === client.id &&
                          i.remainingAmount > 0 &&
                          i.dueDate &&
                          new Date(i.dueDate) < new Date(),
                      );
                      return (
                        <TableRow
                          key={client.id}
                          className={`cursor-pointer ${hasOverdue ? "bg-red-50/50" : ""}`}
                          onClick={() =>
                            setSelectedClientId(selectedClientId === client.id ? null : client.id)
                          }
                        >
                          <TableCell className="font-medium px-4 whitespace-nowrap">
                            {client.companyName}
                          </TableCell>
                          <TableCell className="text-center px-4 whitespace-nowrap text-sm">
                            {client.contactPerson}
                          </TableCell>
                          <TableCell
                            dir="ltr"
                            className="text-center px-4 whitespace-nowrap text-sm"
                          >
                            {client.phone}
                          </TableCell>
                          <TableCell className="text-center px-4 whitespace-nowrap">
                            {formatMoney(invoiced)}
                          </TableCell>
                          <TableCell className="text-center px-4 whitespace-nowrap">
                            {formatMoney(paid)}
                          </TableCell>
                          <TableCell
                            className={
                              "text-center px-4 whitespace-nowrap" +
                              (hasDebt ? " font-semibold text-amber-600" : "")
                            }
                          >
                            {formatMoney(owed)}
                          </TableCell>
                          <TableCell className="text-center px-4">
                            <Badge
                              variant={
                                hasOverdue ? "destructive" : hasDebt ? "secondary" : "default"
                              }
                            >
                              {hasOverdue ? "حساب متأخر" : hasDebt ? "عليه رصيد" : "حساب جيد"}
                            </Badge>
                          </TableCell>
                          <TableCell
                            className="text-center px-4"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div className="flex items-center justify-center">
                              <Button variant="ghost" size="icon" className="size-8" asChild>
                                <a href={`tel:${client.phone}`}>
                                  <Phone className="size-3.5" />
                                </a>
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {selectedClientId && selectedClientData && (
            <Card>
              <div className="p-5 border-b border-border flex items-center justify-between">
                <div>
                  <h3 className="font-display text-lg font-bold">
                    {selectedClientData.companyName}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    سجل الفواتير — {selectedClientData.contactPerson} | {selectedClientData.phone}
                  </p>
                </div>
                <div className="text-left">
                  <p className="text-sm text-muted-foreground">إجمالي الديون</p>
                  <p className="font-bold text-lg">
                    {formatMoney(debtOf(selectedClientData.id))}
                  </p>
                </div>
              </div>
              <CardContent className="p-0">
                {selectedClientInvoices.length === 0 ? (
                  <EmptyState
                    icon={Inbox}
                    title="لا توجد فواتير لهذا العميل"
                    className="py-12"
                  />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-right px-4">الفاتورة</TableHead>
                        <TableHead className="text-center px-4">التاريخ</TableHead>
                        <TableHead className="text-center px-4">الإجمالي</TableHead>
                        <TableHead className="text-center px-4">المدفوع</TableHead>
                        <TableHead className="text-center px-4">المتبقي</TableHead>
                        <TableHead className="text-center px-4">دفعة</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {selectedClientInvoices.map((inv) => (
                        <TableRow key={inv.id}>
                          <TableCell className="font-mono text-xs px-4 whitespace-nowrap">
                            {inv.invoiceNumber}
                          </TableCell>
                          <TableCell className="text-center px-4 whitespace-nowrap text-sm">
                            {new Date(inv.createdAt).toLocaleDateString("ar-EG")}
                          </TableCell>
                          <TableCell className="text-center px-4 whitespace-nowrap">
                            {formatMoney(inv.totalAmount)}
                          </TableCell>
                          <TableCell className="text-center px-4 whitespace-nowrap">
                            {formatMoney(inv.paidAmount)}
                          </TableCell>
                          <TableCell
                            className={
                              "text-center px-4 whitespace-nowrap" +
                              (inv.remainingAmount > 0 ? " font-semibold text-amber-600" : "")
                            }
                          >
                            {formatMoney(inv.remainingAmount)}
                          </TableCell>
                          <TableCell className="text-center px-4">
                            <div className="flex items-center justify-center">
                              {inv.remainingAmount > 0 && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-8 text-xs"
                                  onClick={() => openPayment(inv.id)}
                                >
                                  <DollarSign className="size-3 ml-1" />
                                  تسجيل دفعة
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          )}

          {wholesaleClients.length === 0 && (
            <div className="text-center py-6">
              <Button variant="outline" onClick={() => setIsNewClientOpen(true)}>
                <Plus className="size-4 ml-2" />
                إضافة عميل جديد
              </Button>
            </div>
          )}
        </div>
      )}

      <Dialog
        open={isInvoiceOpen}
        onOpenChange={(open) => {
          setIsInvoiceOpen(open);
          if (!open) resetInvoiceForm();
        }}
      >
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>إنشاء فاتورة جملة</DialogTitle>
            <DialogDescription>أدخل بيانات الفاتورة والمنتجات</DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>العميل</Label>
                <div className="flex gap-2">
                  <Select
                    value={invoiceForm.clientId}
                    onValueChange={(v) => setInvoiceForm({ ...invoiceForm, clientId: v })}
                  >
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder="اختر عميلاً" />
                    </SelectTrigger>
                    <SelectContent>
                      {wholesaleClients.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.companyName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-9 shrink-0"
                    onClick={() => setIsNewClientOpen(true)}
                  >
                    <Plus className="size-4" />
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dueDate">تاريخ استحقاق الباقي</Label>
                <Input
                  id="dueDate"
                  type="date"
                  value={invoiceForm.dueDate}
                  onChange={(e) => setInvoiceForm({ ...invoiceForm, dueDate: e.target.value })}
                />
              </div>
            </div>

            <div className="rounded-xl border border-border p-4 space-y-3 bg-muted/30">
              <p className="text-sm font-medium">إضافة منتجات</p>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <div className="sm:col-span-2">
                  <Select value={selectedProductId} onValueChange={setSelectedProductId}>
                    <SelectTrigger>
                      <SelectValue placeholder="اختر منتج..." />
                    </SelectTrigger>
                    <SelectContent>
                      {products
                        .filter((p) => qtyOf(p.id) > 0)
                        .map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name} — {formatMoney(productWholesalePrice(p))} (المخزون: {qtyOf(p.id)})
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                {selectedProductId && (
                  <div>
                    <Input
                      type="number"
                      min="1"
                      max={selectedProduct ? qtyOf(selectedProduct.id) : 1}
                      placeholder="الكمية"
                      value={itemQty}
                      onChange={(e) =>
                        setItemQty(
                          Math.max(
                            1,
                            Math.min(
                              parseInt(e.target.value) || 1,
                              selectedProduct ? qtyOf(selectedProduct.id) : 1,
                            ),
                          ),
                        )
                      }
                    />
                  </div>
                )}
                {selectedProductId && (
                  <Button onClick={addItemToInvoice} disabled={!selectedProduct}>
                    <Plus className="size-4 ml-1" />
                    إضافة
                  </Button>
                )}
              </div>
            </div>

              {invoiceItems.length > 0 && (
                <div className="border-t border-border pt-3 space-y-2">
                  {invoiceItems.map((item) => (
                    <div
                      key={item.productId}
                      className="flex items-center justify-between text-sm p-2 rounded-lg bg-background"
                    >
                      <div className="flex-1">
                        <span className="font-medium">{item.productName}</span>
                        <span className="text-muted-foreground mr-3">
                          {item.quantity} × {formatMoney(item.wholesalePrice)}
                        </span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="font-semibold">{formatMoney(item.total)}</span>
                        <button
                          onClick={() => removeInvoiceItem(item.productId)}
                          className="text-destructive hover:text-destructive/80"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            <div className="rounded-xl border border-border p-4 space-y-3">
              <p className="text-sm font-medium">شروط الدفع</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <Label>المبلغ الإجمالي</Label>
                  <div className="h-9 rounded-md border border-input bg-muted/50 px-3 flex items-center text-sm font-semibold">
                    {formatMoney(invoiceTotal)}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="paidAmount">المدفوع مقدمًا</Label>
                  <Input
                    id="paidAmount"
                    type="number"
                    min="0"
                    max={invoiceTotal}
                    value={invoiceForm.paidAmount || ""}
                    onChange={(e) =>
                      setInvoiceForm({
                        ...invoiceForm,
                        paidAmount: Math.min(parseFloat(e.target.value) || 0, invoiceTotal),
                      })
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>المتبقي</Label>
                  <div
                    className={`h-9 rounded-md border px-3 flex items-center text-sm font-semibold ${remainingAfterPaid > 0 ? "border-amber-200 bg-amber-50 text-amber-700" : "border-green-200 bg-green-50 text-green-700"}`}
                  >
                    {formatMoney(remainingAfterPaid)}
                  </div>
                </div>
                {invoiceForm.paidAmount > 0 && (
                  <div className="space-y-1.5">
                    <Label>الخزينة اللي هيتحصّل فيها</Label>
                    <Select
                      value={invoiceForm.wallet}
                      onValueChange={(v) =>
                        setInvoiceForm({ ...invoiceForm, wallet: v as WalletType })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(WALLET_LABELS).map(([key, label]) => (
                          <SelectItem key={key} value={key}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="notes">ملاحظات</Label>
                <Input
                  id="notes"
                  value={invoiceForm.notes}
                  onChange={(e) => setInvoiceForm({ ...invoiceForm, notes: e.target.value })}
                  placeholder="ملاحظات إضافية للفاتورة (اختياري)"
                />
              </div>
            </div>
          </div>

          <ShippingSelector
            value={shippingInfo}
            onChange={setShippingInfo}
            personaLabel="يتطلب شحن؟"
          />

          <DialogFooter className="mt-6 flex gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setIsInvoiceOpen(false);
                resetInvoiceForm();
              }}
              disabled={isSubmitting}
            >
              إلغاء
            </Button>
            <Button
              onClick={() => void submitInvoice()}
              disabled={!invoiceForm.clientId || invoiceItems.length === 0 || isSubmitting}
            >
              {isSubmitting && <Loader2 className="ml-2 h-4 w-4 animate-spin" />}
              {isSubmitting ? "جاري الحفظ..." : "حفظ الفاتورة وتسجيل الرصيد"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isNewClientOpen} onOpenChange={setIsNewClientOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>إضافة عميل جديد</DialogTitle>
            <DialogDescription>أدخل بيانات الشركة أو العميل</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="companyName">اسم الشركة / العميل</Label>
              <Input
                id="companyName"
                value={newClientForm.companyName}
                onChange={(e) =>
                  setNewClientForm({ ...newClientForm, companyName: e.target.value })
                }
                placeholder="شركة النور للتجارة"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="contactPerson">جهة الاتصال</Label>
              <Input
                id="contactPerson"
                value={newClientForm.contactPerson}
                onChange={(e) =>
                  setNewClientForm({ ...newClientForm, contactPerson: e.target.value })
                }
                placeholder="أحمد محمد"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="phone">رقم الهاتف</Label>
              <Input
                id="phone"
                dir="ltr"
                value={newClientForm.phone}
                onChange={(e) => setNewClientForm({ ...newClientForm, phone: e.target.value })}
                placeholder="+20 100 000 0000"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="newClientEmail">البريد الإلكتروني</Label>
              <Input
                id="newClientEmail"
                type="email"
                dir="ltr"
                value={newClientForm.email}
                onChange={(e) => setNewClientForm({ ...newClientForm, email: e.target.value })}
                placeholder="info@example.com"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsNewClientOpen(false)}>
              إلغاء
            </Button>
            <Button
              onClick={() => {
                if (!newClientForm.companyName.trim() || !newClientForm.phone.trim()) return;
                addWholesaleClient({
                  companyName: newClientForm.companyName.trim(),
                  contactPerson:
                    newClientForm.contactPerson.trim() || newClientForm.companyName.trim(),
                  phone: newClientForm.phone.trim(),
                  email: newClientForm.email.trim() || undefined,
                });
                setNewClientForm({ companyName: "", contactPerson: "", phone: "", email: "" });
                setIsNewClientOpen(false);
              }}
              disabled={!newClientForm.companyName.trim() || !newClientForm.phone.trim()}
            >
              إضافة العميل
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isPaymentOpen} onOpenChange={setIsPaymentOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>تسجيل دفعة جديدة</DialogTitle>
            <DialogDescription>أدخل المبلغ المدفوع</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="paymentAmount">المبلغ</Label>
              <Input
                id="paymentAmount"
                type="number"
                min="0"
                max={paymentInvoice?.remainingAmount}
                value={paymentAmount || ""}
                onChange={(e) =>
                  setPaymentAmount(
                    Math.min(parseFloat(e.target.value) || 0, paymentInvoice?.remainingAmount ?? 0),
                  )
                }
                placeholder="0.00"
              />
              {paymentInvoice && (
                <p className="text-xs text-muted-foreground">
                  المتبقي على الفاتورة: {formatMoney(paymentInvoice.remainingAmount)}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>الخزينة اللي هيتحصّل فيها</Label>
              <Select value={paymentWallet} onValueChange={(v) => setPaymentWallet(v as WalletType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(WALLET_LABELS).map(([key, label]) => (
                    <SelectItem key={key} value={key}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter className="mt-6 flex gap-2">
            <Button variant="outline" onClick={() => setIsPaymentOpen(false)} disabled={isPaying}>
              إلغاء
            </Button>
            <Button onClick={() => void submitPayment()} disabled={paymentAmount <= 0 || isPaying}>
              {isPaying && <Loader2 className="ml-2 h-4 w-4 animate-spin" />}
              {isPaying ? "جاري التسجيل..." : "تسجيل الدفعة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
