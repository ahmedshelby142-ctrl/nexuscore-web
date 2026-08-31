import { useState, useMemo, useRef } from "react";
import { formatMoney } from "@/lib/math";
import { useDraftState, clearDrafts } from "@/hooks/useDraftState";
import {
  Package,
  Plus,
  AlertTriangle,
  DollarSign,
  Search,
  Pencil,
  Trash2,
  PackageCheck,
  FileSpreadsheet,
  RotateCcw,
  Loader2,
  Inbox,
  UploadCloud,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useBusinessStore } from "@/store/useBusinessStore";
import { appendOpeningBalance } from "@/lib/ledger/openingBalance";
import { appendEvent } from "@/lib/ledger";
import { useStock } from "@/lib/ledger/useStock";
import {
  StockSummaryCards,
  matchesStockFilter,
  stockStatusOf,
  type StockFilter,
} from "@/components/inventory/StockSummaryCards";
import { useAuthStore } from "@/store/useAuthStore";
import { toAppRole } from "@/lib/roles";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { BulkImportProduct } from "./BulkImportProduct";
import { ProductRemovalDialog } from "./ProductRemovalDialog";
import { QuickRestockDialog } from "./QuickRestockDialog";
import { searchProducts } from "@/lib/productSearch";
import { activeProducts, isProductArchived, sellableStock } from "@/lib/product";
import type { Product } from "@/types";

const defaultCategories = [
  "إلكترونيات",
  "ملابس",
  "أحذية",
  "إكسسوارات",
  "مواد غذائية",
  "مشروبات",
  "منتجات عناية",
  "أدوات منزلية",
  "ألعاب",
  "أخرى",
];

// No `costPrice`. A product's cost is the weighted average of what was paid on
// توريد — a SUM over the ledger (§1.1) — and this form already captures the
// real thing as the opening balance's "تكلفة الوحدة", which writes an event.
// Two cost boxes on one form, only one of which reached the ledger, is what the
// stored field bought us.
const emptyForm: Omit<Product, "id" | "updated_at" | "isActive" | "quantity"> = {
  name: "",
  sku: "",
  barcode: "",
  category: "",
  unitPrice: 0,
  wholesalePrice: 0,
  minStockLevel: 0,
  maxStockLevel: 0,
  description: "",
  image_url: "",
  metadata: { variants: [] },
};


export function ProductsPage() {
  const { products: allProducts, addProduct, updateProduct, restoreProduct } = useBusinessStore();
  // Archived products keep their record (their ledger events must still
  // resolve) but leave every active list, this one included. The المؤرشفة tab
  // below is the one place they are visible — and the way back.
  const products = useMemo(() => activeProducts(allProducts), [allProducts]);
  const archivedList = useMemo(() => allProducts.filter(isProductArchived), [allProducts]);
  const [showArchived, setShowArchived] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<Product | null>(null);
  const [restocking, setRestocking] = useState<Product | null>(null);
  const [zoomedImage, setZoomedImage] = useState<string | null>(null);
  // Stock on this screen is the ledger's SUM, and an opening balance is how a
  // shop that already has stock gets its first numbers in.
  const { qtyOf, costOf, refresh: refreshStock } = useStock();
  const userRole = useAuthStore((s) => s.userRole);
  const isOwner = toAppRole(userRole) === "ADMIN";

  const [searchQuery, setSearchQuery] = useState("");
  // The product form and its dialog are drafted together, so stepping away
  // mid-entry (to check a supplier, say) does not throw the entry away.
  const [isDialogOpen, setIsDialogOpen] = useDraftState("product:dialogOpen", false);
  const [editingProduct, setEditingProduct] = useDraftState<Product | null>(
    "product:editing",
    null,
  );
  // Enter in the barcode field hands focus on to the category picker rather
  // than submitting the form.
  const barcodeFieldRef = useRef<HTMLInputElement>(null);
  const categoryTriggerRef = useRef<HTMLButtonElement>(null);
  const [form, setForm] = useDraftState("product:form", emptyForm);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [showBulkImport, setShowBulkImport] = useState(false);
  // Opening balance — the stock the shop already owns today. Only offered when
  // ADDING; see the note on the field itself for why editing must not re-add it.
  const [openingQty, setOpeningQty] = useDraftState("product:openingQty", "");
  const [openingCost, setOpeningCost] = useDraftState("product:openingCost", "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [stockStatusFilter, setStockStatusFilter] = useState<StockFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState("all");

  // The categories actually in use, not the default list — a filter offering
  // an empty category is a dead end.
  const categoriesInUse = useMemo(
    () => [...new Set(allProducts.map((p) => p.category).filter(Boolean))].sort(),
    [allProducts],
  );

  const filteredProducts = useMemo(() => {
    // The shared matcher — same one POS, الطلبات and المرتجعات search with, so
    // "منتج-١٢٣" finds "123" here too. It used to be a private `toLowerCase`
    // filter that missed Arabic-Indic digits entirely.
    let result = searchProducts(showArchived ? archivedList : products, searchQuery);
    if (categoryFilter !== "all") {
      result = result.filter((p) => p.category === categoryFilter);
    }
    // The stock cards describe the shelf, so their filter belongs to the
    // active list only — an archived product is off the shelf by definition.
    if (showArchived) return result;
    // Same predicate the cards counted with, so a card's number always equals
    // the number of rows clicking it produces.
    result = result.filter((p) => {
      const displayQty = sellableStock(p, products);
      return matchesStockFilter(displayQty, p, stockStatusFilter);
    });
    return result;
  }, [products, archivedList, showArchived, searchQuery, categoryFilter, stockStatusFilter]);

  function openAddDialog() {
    clearDrafts("product:");
    setEditingProduct(null);
    setForm(emptyForm);
    setFormErrors({});
    setOpeningQty("");
    setOpeningCost("");
    setIsDialogOpen(true);
  }

  function openEditDialog(product: Product) {
    clearDrafts("product:");
    setEditingProduct(product);
    setForm({
      name: product.name,
      sku: product.sku,
      barcode: product.barcode || "",
      category: product.category,
      unitPrice: product.unitPrice,
      wholesalePrice: product.wholesalePrice,
      minStockLevel: product.minStockLevel,
      maxStockLevel: product.maxStockLevel,
      description: product.description || "",
      metadata: product.metadata || { variants: [] },
    });
    setFormErrors({});
    setOpeningQty("");
    setOpeningCost("");
    setIsDialogOpen(true);
  }

  function validate(): boolean {
    const errors: Record<string, string> = {};
    if (!form.name.trim()) errors.name = "اسم المنتج مطلوب";
    if (!form.sku.trim()) errors.sku = "SKU مطلوب";
    if (!form.category) errors.category = "التصنيف مطلوب";
    // Barcode is optional, but when present it must identify exactly one
    // product — a duplicate makes every POS scan ambiguous (brief §3.2).
    const barcode = (form.barcode ?? "").trim();
    if (barcode) {
      const clash = products.find(
        (p) => p.barcode?.trim() === barcode && p.id !== editingProduct?.id,
      );
      if (clash) errors.barcode = `الباركود ده مستخدم بالفعل في "${clash.name}"`;
    }
    const sku = form.sku.trim();
    if (sku) {
      const clash = products.find((p) => p.sku?.trim() === sku && p.id !== editingProduct?.id);
      if (clash) errors.sku = `الـ SKU ده مستخدم بالفعل في "${clash.name}"`;
    }
    if (form.unitPrice <= 0) errors.unitPrice = "سعر البيع قطاعي مطلوب";
    if (form.wholesalePrice <= 0) errors.wholesalePrice = "سعر البيع جملة مطلوب";
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    setIsSubmitting(true);

    try {
      const data = {
        name: form.name.trim(),
        sku: form.sku.trim(),
        barcode: (form.barcode ?? "").trim() || undefined,
        category: form.category,
        unitPrice: form.unitPrice,
        wholesalePrice: form.wholesalePrice,
        minStockLevel: form.minStockLevel,
        maxStockLevel: form.maxStockLevel,
        description: (form.description ?? "").trim() || undefined,
        image_url: (form.image_url ?? "").trim() || undefined,
        metadata: form.metadata,
        isActive: true,
      };

      const hasVariants = form.metadata?.variants && form.metadata.variants.length > 0;
      const totalVariantStock = hasVariants && form.metadata?.variants
        ? form.metadata.variants.reduce((sum, v) => sum + (v.stock || 0), 0)
        : 0;

      if (editingProduct) {
        // `sellableStock` prefers the variants, but totalQuantity is what a
        // plain product is read by and what sync carries — so on a variant
        // product it is kept equal to their sum rather than left stale.
        await updateProduct(editingProduct.id, {
          ...data,
          ...(hasVariants ? { totalQuantity: totalVariantStock } : {}),
        });
        
        // STRICT SYNCHRONIZATION: Total stock must match sum of variants exactly.
        const currentTotal = qtyOf(editingProduct.id);
        if (hasVariants && totalVariantStock !== currentTotal) {
          const difference = totalVariantStock - currentTotal;
          await appendEvent({
            kind: "stock_adjustment",
            actor: "النظام",
            refType: "product_edit",
            payload: {
              notes: "تسوية تلقائية لمطابقة مجموع مخزون الدرجات/الأنواع",
            },
            lines: [
              {
                account: "stock",
                subjectId: editingProduct.id,
                qty: difference,
                unitCost: 0,
              }
            ]
          });
          refreshStock();
        }

        clearDrafts("product:");
        setIsDialogOpen(false);
        return;
      }

      const qty = hasVariants ? totalVariantStock : (parseFloat(openingQty) || 0);

      // The opening quantity goes on the RECORD as well as into the ledger
      // event below. Every selling screen reads the record through
      // `sellableStock`, so a product created with 40 on the shelf and no
      // `totalQuantity` would show up as نفد المخزون the moment it was saved.
      const product = await addProduct({ ...data, totalQuantity: qty });

      if (qty <= 0) {
        // No opening balance entered — the product starts at zero, and stock
        // arrives the normal way, through a توريد.
        clearDrafts("product:");
        setIsDialogOpen(false);
        return;
      }

      // ONE event. The user is asserting a real fact — "I have 40 of these on
      // the shelf right now" — so it is recorded as an event like any other,
      // not written into a stored quantity. This is what makes it an opening
      // balance rather than the invented seed data we deleted. The Excel
      // importer records its quantity column through this same function.
      await appendOpeningBalance({
        productId: product.id,
        productName: product.name,
        quantity: qty,
        unitCost: parseFloat(openingCost) || 0,
      });
      refreshStock();
      clearDrafts("product:");
      setIsDialogOpen(false);
    } catch (e) {
      toast.error(
        `المنتج اتسجّل، لكن الكمية الموجودة حالياً متسجلتش. سجّلها من شاشة الجرد. ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  // The trash icon only ASKS now. What it asks — مسح نهائي or أرشفة — depends
  // on whether the ledger has ever recorded this product; the dialog decides.
  function handleDelete(product: Product) {
    setPendingRemoval(product);
  }

  function updateField<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (formErrors[key as string]) {
      setFormErrors((prev) => {
        const next = { ...prev };
        delete next[key as string];
        return next;
      });
    }
  }

  const addVariant = () => {
    const variants = form.metadata?.variants || [];
    updateField("metadata", { ...form.metadata, variants: [...variants, { name: "", stock: 0 }] });
  };

  const removeVariant = (idx: number) => {
    const variants = form.metadata?.variants || [];
    const newVariants = [...variants];
    newVariants.splice(idx, 1);
    updateField("metadata", { ...form.metadata, variants: newVariants });
  };

  const updateVariant = (idx: number, field: "name" | "stock", value: any) => {
    const variants = form.metadata?.variants || [];
    const newVariants = [...variants];
    newVariants[idx] = { ...newVariants[idx], [field]: value };
    updateField("metadata", { ...form.metadata, variants: newVariants });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold">إدارة المنتجات</h1>
          <p className="text-muted-foreground mt-1">عرض وإدارة جميع المنتجات في المخازن</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={openAddDialog} className="gap-2 h-10 px-5">
            <Plus className="size-4" />
            إضافة منتج يدوياً
          </Button>
          {isOwner && (
            <Button
              onClick={() => setShowBulkImport(!showBulkImport)}
              variant="outline"
              className="gap-2 h-10 px-5"
            >
              <FileSpreadsheet className="size-4" />
              استيراد المنتجات عبر إكسل
            </Button>
          )}
        </div>
      </div>

      {/* Bulk Import Section */}
      {showBulkImport && (
        <BulkImportProduct onClose={() => setShowBulkImport(false)} onImported={refreshStock} />
      )}

      <ProductRemovalDialog
        product={pendingRemoval}
        onClose={() => setPendingRemoval(null)}
        onRemoved={refreshStock}
      />

      <QuickRestockDialog
        products={restocking ? [restocking] : null}
        onClose={() => setRestocking(null)}
        onReceived={refreshStock}
      />


      {/* Stats Summary — Interactive Quick Filters. The shelf, so active only. */}
      {!showArchived && (
        <StockSummaryCards
          products={products}
          value={stockStatusFilter}
          onChange={setStockStatusFilter}
        />
      )}

      {/* Search & Table */}
      <Card>
        <div className="p-5 pb-0 flex flex-wrap items-center gap-3">
          <div className="relative max-w-sm flex-1 min-w-[14rem]">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder="بحث بالاسم، SKU، الباركود..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pr-9"
            />
          </div>
          {/* Category filter — the status filter is the summary cards above,
              so the two never contradict each other. */}
          {categoriesInUse.length > 0 && (
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              aria-label="تصفية بالتصنيف"
            >
              <option value="all">كل التصنيفات</option>
              {categoriesInUse.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          )}
          {/* المؤرشفة: an archived product is hidden, not gone — this is where
              it is seen and brought back. */}
          <div className="flex items-center gap-1 rounded-lg border border-border p-1">
            <Button
              variant={showArchived ? "ghost" : "secondary"}
              size="sm"
              onClick={() => setShowArchived(false)}
            >
              النشطة ({products.length})
            </Button>
            <Button
              variant={showArchived ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setShowArchived(true)}
            >
              المؤرشفة ({archivedList.length})
            </Button>
          </div>
        </div>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right px-4">اسم المنتج</TableHead>
                <TableHead className="text-center px-4">الباركود / SKU</TableHead>
                <TableHead className="text-center px-4">التصنيف</TableHead>
                <TableHead className="text-center px-4">متوسط التكلفة</TableHead>
                <TableHead className="text-center px-4">قطاعي</TableHead>
                <TableHead className="text-center px-4">جملة</TableHead>
                <TableHead className="text-center px-4">الكمية</TableHead>
                <TableHead className="text-center px-4">الحالة</TableHead>
                <TableHead className="text-center px-4">إجراءات</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredProducts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="py-12">
                    {showArchived ? (
                      <EmptyState
                        icon={Inbox}
                        title="مفيش منتجات مؤرشفة"
                        description="المنتج اللي ليه حركات في الدفتر بيتأرشف بدل ما يتمسح، وبيظهر هنا"
                      />
                    ) : products.length === 0 ? (
                      <EmptyState
                        icon={Inbox}
                        title="لسه مفيش منتجات"
                        description="ابدأ بإضافة منتج، وبعدين سجّل فاتورة توريد عشان يدخل مخزون فعلي"
                      />
                    ) : (
                      <EmptyState
                        icon={Search}
                        title="لا توجد نتائج مطابقة للبحث"
                        description="جرب بحث تاني أو غيّر التصنيف"
                      />
                    )}
                  </TableCell>
                </TableRow>
              ) : (
                filteredProducts.map((product) => {
                  const displayQty = sellableStock(product, products);
                  const status = stockStatusOf(displayQty, product);
                  return (
                    <TableRow key={product.id}>
                      <TableCell className="font-medium px-4 whitespace-nowrap min-w-[200px]">
                        <div className="flex items-center gap-3">
                          {product.image_url ? (
                            <img 
                              src={product.image_url} 
                              alt={product.name} 
                              className="size-10 object-cover rounded bg-muted shrink-0 border border-border cursor-pointer hover:opacity-80 transition-opacity" 
                              onClick={() => setZoomedImage(product.image_url ?? null)}
                            />
                          ) : (
                            <div className="size-10 rounded bg-muted shrink-0 flex items-center justify-center border border-border">
                              <span className="text-xs text-muted-foreground">{product.name.substring(0, 2)}</span>
                            </div>
                          )}
                          <span className="truncate">{product.name}</span>
                        </div>
                      </TableCell>
                      <TableCell
                        dir="ltr"
                        className="text-center px-4 font-mono text-xs whitespace-nowrap"
                      >
                        {product.barcode || product.sku}
                      </TableCell>
                      <TableCell className="text-center px-4 whitespace-nowrap">
                        <span className="text-sm bg-muted/60 px-2 py-0.5 rounded-md">
                          {product.category}
                        </span>
                      </TableCell>
                      <TableCell className="text-center px-4 whitespace-nowrap">
                        {formatMoney(costOf(product.id))}
                      </TableCell>
                      <TableCell className="text-center px-4 whitespace-nowrap">
                        {formatMoney(product.unitPrice)}
                      </TableCell>
                      <TableCell className="text-center px-4 whitespace-nowrap">
                        {formatMoney(product.wholesalePrice)}
                      </TableCell>
                      <TableCell className="text-center px-4 whitespace-nowrap">
                        {/* The ledger's quantity, coloured by the same status
                            the cards counted with. */}
                        <div className="relative group flex justify-center items-center gap-1 cursor-pointer">
                          <span
                            className={cn(
                              "font-semibold",
                              status.variant === "secondary" && "text-amber-600",
                              status.variant === "destructive" && "text-destructive",
                            )}
                          >
                            {displayQty}
                          </span>
                          {product.metadata?.variants && product.metadata.variants.length > 0 && (
                            <>
                              <Badge variant="outline" className="text-[10px] h-4 px-1.5 opacity-80 gap-1 flex items-center border-border/60">
                                <span className="font-medium">{product.metadata.variants.length} أنواع</span>
                              </Badge>
                              {/* Hover Popover */}
                              <div className="absolute top-full mt-2 left-1/2 -translate-x-1/2 w-48 bg-popover border border-border shadow-lg rounded-xl p-3 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50">
                                <p className="text-xs font-bold mb-2 border-b border-border pb-1">تفاصيل المخزون (درجات)</p>
                                <div className="space-y-1">
                                  {product.metadata.variants.map((v, idx) => (
                                    <div key={idx} className="flex items-center justify-between text-xs">
                                      <span className="truncate flex-1 text-right">{v.name}</span>
                                      <span className="font-mono text-muted-foreground">{v.stock}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-center px-4">
                        <Badge variant={status.variant}>{status.label}</Badge>
                      </TableCell>
                      <TableCell className="text-center px-4">
                        {showArchived ? (
                          // One action, and it is the reverse of archiving —
                          // no second delete path lives here.
                          <Button
                            variant="outline"
                            size="sm"
                            className="gap-1.5"
                            onClick={() => restoreProduct(product.id)}
                          >
                            <RotateCcw className="size-3.5" />
                            استرجاع
                          </Button>
                        ) : (
                          <div className="flex items-center justify-center gap-1">
                            {/* توريد سريع — the most frequent action on this
                                row, so it does not send the owner to another
                                screen to receive one line. */}
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8 text-primary hover:text-primary"
                              title="توريد سريع"
                              onClick={() => setRestocking(product)}
                            >
                              <PackageCheck className="size-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8"
                              title="تعديل"
                              onClick={() => openEditDialog(product)}
                            >
                              <Pencil className="size-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8 text-destructive hover:text-destructive"
                              title="مسح أو أرشفة"
                              onClick={() => handleDelete(product)}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Lightbox / Zoom Dialog */}
      <Dialog open={!!zoomedImage} onOpenChange={(open) => !open && setZoomedImage(null)}>
        <DialogContent className="max-w-4xl bg-transparent border-none shadow-none p-0 flex justify-center items-center overflow-visible">
          {zoomedImage && (
            <img 
              src={zoomedImage} 
              alt="Zoomed" 
              className="max-h-[85vh] max-w-[95vw] object-contain rounded-xl drop-shadow-2xl"
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Add/Edit Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingProduct ? "تعديل المنتج" : "إضافة منتج جديد"}</DialogTitle>
            <DialogDescription>
              {editingProduct ? "قم بتحديث بيانات المنتج أدناه." : "أدخل بيانات المنتج الجديد."}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Name */}
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="name">اسم المنتج</Label>
                <Input
                  id="name"
                  value={form.name}
                  onChange={(e) => updateField("name", e.target.value)}
                  placeholder="اسم المنتج بالعربية"
                />
                {formErrors.name && <p className="text-xs text-destructive">{formErrors.name}</p>}
              </div>

              {/* SKU */}
              <div className="space-y-1.5">
                <Label htmlFor="sku">SKU</Label>
                <Input
                  id="sku"
                  value={form.sku}
                  onChange={(e) => updateField("sku", e.target.value)}
                  placeholder="PROD-001"
                />
                {formErrors.sku && <p className="text-xs text-destructive">{formErrors.sku}</p>}
              </div>

              {/* Barcode — a scanner types the code and sends Enter. That
                  Enter must NOT save the product half-filled; it just moves to
                  the next field so the next scan or entry continues. */}
              <div className="space-y-1.5">
                <Label htmlFor="barcode">الباركود</Label>
                <Input
                  id="barcode"
                  ref={barcodeFieldRef}
                  value={form.barcode}
                  onChange={(e) => updateField("barcode", e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      categoryTriggerRef.current?.focus();
                    }
                  }}
                  placeholder="امسح الباركود أو اكتبه"
                  dir="ltr"
                />
                {formErrors.barcode && (
                  <p className="text-xs text-destructive">{formErrors.barcode}</p>
                )}
              </div>

              {/* Category */}
              <div className="space-y-1.5">
                <Label>التصنيف</Label>
                <Select value={form.category} onValueChange={(v) => updateField("category", v)}>
                  <SelectTrigger ref={categoryTriggerRef}>
                    <SelectValue placeholder="اختر التصنيف" />
                  </SelectTrigger>
                  <SelectContent>
                    {defaultCategories.map((cat) => (
                      <SelectItem key={cat} value={cat}>
                        {cat}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {formErrors.category && (
                  <p className="text-xs text-destructive">{formErrors.category}</p>
                )}
              </div>

              <div className="border-t border-border pt-4 sm:col-span-2">
                <p className="text-sm font-medium mb-3">التسعير</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="unitPrice">سعر البيع قطاعي</Label>
                    <Input
                      id="unitPrice"
                      type="number"
                      min="0"
                      step="0.01"
                      value={form.unitPrice || ""}
                      onChange={(e) => updateField("unitPrice", parseFloat(e.target.value) || 0)}
                    />
                    {formErrors.unitPrice && (
                      <p className="text-xs text-destructive">{formErrors.unitPrice}</p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="wholesalePrice">سعر البيع جملة</Label>
                    <Input
                      id="wholesalePrice"
                      type="number"
                      min="0"
                      step="0.01"
                      value={form.wholesalePrice || ""}
                      onChange={(e) =>
                        updateField("wholesalePrice", parseFloat(e.target.value) || 0)
                      }
                    />
                    {formErrors.wholesalePrice && (
                      <p className="text-xs text-destructive">{formErrors.wholesalePrice}</p>
                    )}
                  </div>
                </div>
              </div>

              <div className="border-t border-border pt-4 sm:col-span-2">
                <p className="text-sm font-medium mb-3">المخزون</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {/* Opening balance. Replaces a "الكمية الحالية" box that wrote
                      a stored quantity nothing reads any more — stock is the
                      ledger's SUM. Offered only when ADDING: on edit it would
                      re-apply and double-count the shelf. */}
                  {editingProduct ? (
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label>المخزون الحالي</Label>
                      <div className="h-9 rounded-md border border-input bg-muted/50 px-3 flex items-center text-sm">
                        {qtyOf(editingProduct.id)} — محسوب من حركات المخزون
                      </div>
                      <p className="text-xs text-muted-foreground">
                        عشان تعدّل الكمية، اعمل جرد أو سجّل فاتورة توريد — مش من هنا.
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="space-y-1.5">
                        <Label htmlFor="openingQty">الكمية الموجودة حالياً</Label>
                        <Input
                          id="openingQty"
                          type="number"
                          min="0"
                          value={openingQty}
                          onChange={(e) => setOpeningQty(e.target.value)}
                          placeholder="اختياري"
                        />
                        <p className="text-xs text-muted-foreground">
                          الكمية اللي عندك على الرف دلوقتي. سيبها فاضية لو المنتج جديد.
                        </p>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="openingCost">تكلفة الوحدة للكمية دي</Label>
                        <Input
                          id="openingCost"
                          type="number"
                          min="0"
                          step="0.01"
                          value={openingCost}
                          onChange={(e) => setOpeningCost(e.target.value)}
                          placeholder="اختياري"
                        />
                        <p className="text-xs text-muted-foreground">
                          اللي دفعته في الوحدة وقت ما اشتريتها — بيحدد تكلفة البيع بعد كده.
                        </p>
                      </div>
                    </>
                  )}
                  <div className="space-y-1.5">
                    <Label htmlFor="minStockLevel">حد الطلب الأدنى</Label>
                    <Input
                      id="minStockLevel"
                      type="number"
                      min="0"
                      value={form.minStockLevel || ""}
                      onChange={(e) => updateField("minStockLevel", parseInt(e.target.value) || 0)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="maxStockLevel">الحد الأقصى</Label>
                    <Input
                      id="maxStockLevel"
                      type="number"
                      min="0"
                      value={form.maxStockLevel || ""}
                      onChange={(e) => updateField("maxStockLevel", parseInt(e.target.value) || 0)}
                    />
                  </div>
                </div>

                <div className="space-y-2 mt-4 sm:col-span-2">
                  <label className="text-sm font-medium">صورة المنتج</label>
                  <div
                    className="border-2 border-dashed border-border rounded-xl p-6 flex flex-col items-center justify-center text-center hover:bg-muted/30 transition-colors cursor-pointer"
                    onClick={() => {
                      const input = document.createElement('input');
                      input.type = 'file';
                      input.accept = 'image/*';
                      input.onchange = (e) => {
                        const file = (e.target as HTMLInputElement).files?.[0];
                        if (file) {
                          const reader = new FileReader();
                          reader.onload = (ev) => updateField("image_url", ev.target?.result as string);
                          reader.readAsDataURL(file);
                        }
                      };
                      input.click();
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const file = e.dataTransfer.files?.[0];
                      if (file && file.type.startsWith('image/')) {
                        const reader = new FileReader();
                        reader.onload = (ev) => updateField("image_url", ev.target?.result as string);
                        reader.readAsDataURL(file);
                      }
                    }}
                  >
                    {form.image_url ? (
                      <div className="relative group">
                        <img src={form.image_url} alt="Preview" className="h-32 object-contain rounded-md" />
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); updateField("image_url", ""); }}
                          className="absolute -top-2 -right-2 bg-destructive text-destructive-foreground rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <X className="size-3" />
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-2 text-muted-foreground">
                        <UploadCloud className="size-8 mx-auto opacity-50" />
                        <p className="text-sm">اسحب الصورة هنا أو اضغط للاختيار</p>
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Input
                      type="url"
                      placeholder="أو ضع رابط الصورة هنا..."
                      value={form.image_url?.startsWith('http') ? form.image_url : ""}
                      onChange={(e) => updateField("image_url", e.target.value)}
                      dir="ltr"
                      className="text-left flex-1"
                    />
                  </div>
                </div>

                <div className="space-y-4 sm:col-span-2 pt-4 border-t border-border">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="text-base">درجات الألوان / المقاسات (اختياري)</Label>
                      <p className="text-xs text-muted-foreground">أضف خيارات المنتج وسيتم تجميع المخزون تلقائياً.</p>
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={addVariant}>
                      <Plus className="size-4 ml-2" /> إضافة خيار
                    </Button>
                  </div>
                  
                  {form.metadata?.variants && form.metadata.variants.length > 0 && (
                    <div className="space-y-2">
                      {form.metadata.variants.map((v, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <Input 
                            placeholder="اسم الدرجة (مثال: أحمر)" 
                            value={v.name} 
                            onChange={(e) => updateVariant(i, "name", e.target.value)} 
                            className="flex-1"
                          />
                          <Input 
                            type="number" 
                            min="0" 
                            placeholder="المخزون" 
                            value={v.stock || ""} 
                            onChange={(e) => updateVariant(i, "stock", parseInt(e.target.value) || 0)} 
                            className="w-24"
                          />
                          <Button type="button" variant="ghost" size="icon" className="text-destructive shrink-0" onClick={() => removeVariant(i)}>
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="description">وصف</Label>
                <Input
                  id="description"
                  value={form.description}
                  onChange={(e) => updateField("description", e.target.value)}
                  placeholder="وصف المنتج (اختياري)"
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="outline" onClick={() => setIsDialogOpen(false)} disabled={isSubmitting}>
                إلغاء
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting && <Loader2 className="ml-2 h-4 w-4 animate-spin" />}
                {editingProduct ? "حفظ التغييرات" : "إضافة المنتج"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
