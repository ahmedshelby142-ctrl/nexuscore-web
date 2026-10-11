import { useRunOnce } from "@/hooks/useSubmitGate";
import { CollectionGate } from "@/components/ui/collection-gate";
import { useMemo, useState } from "react";
import { useDraftState, clearDrafts } from "@/hooks/useDraftState";
import { Boxes, Package, Plus, Trash2, Save, CheckCircle2 } from "lucide-react";
import { useBusinessStore } from "@/store/useBusinessStore";
import { useStock } from "@/lib/ledger/useStock";
import { formatMoney, formatQty } from "@/lib/math";
import { bundleDefinitionError } from "@/lib/businessDefinitions";
import { activeProducts, bundleAvailableStock, getActualStock } from "@/lib/product";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ProductSearch } from "@/components/products/ProductSearch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { runFinancialCommand, resolvePendingFinancialCommand } from "@/lib/financialCommand";
import { fromRemoteRow } from "@/services/api/fieldMapping";
import { cn } from "@/lib/utils";
import type { Product } from "@/types";

export function BundlesPage() {
  const allProducts = useBusinessStore((s) => s.products);
  const addProduct = useBusinessStore((s) => s.addProduct);
  const updateProduct = useBusinessStore((s) => s.updateProduct);
  const removeProduct = useBusinessStore((s) => s.removeProduct);

  const products = useMemo(() => activeProducts(allProducts), [allProducts]);
  const bundles = useMemo(() => products.filter((p) => p.isBundle), [products]);

  const { qtyOf, costOf } = useStock();
  
  const [name, setName] = useDraftState("bundle:name", "");
  const [sku, setSku] = useDraftState("bundle:sku", "");
  const [price, setPrice] = useDraftState("bundle:price", "");
  const [selected, setSelected] = useDraftState<Record<string, number>>("bundle:selected", {});
  const [editing, setEditing] = useDraftState<any>("bundle:editing", null);
  const [message, setMessage] = useState("");
  const [pendingVariantSelection, setPendingVariantSelection] = useState<{ product: Product } | null>(null);

  const selectedItems = useMemo(
    () =>
      Object.entries(selected)
        .filter(([, quantity]) => quantity >= 0)
        .map(([key, quantity]) => {
          const [productId, variantName] = key.split("::");
          const product = allProducts.find((item) => item.id === productId);
          return { 
            key,
            productId, 
            variantName,
            productName: product ? product.name + (variantName ? ` - ${variantName}` : "") : productId, 
            quantity, 
            cost: costOf(productId) 
          };
        }),
    [selected, allProducts, costOf],
  );

  const selectedStockOk = selectedItems.every((item) => {
    const total = selectedItems.filter(i => i.productId === item.productId).reduce((n,i) => n+i.quantity,0);
    const variant = allProducts.find(p => p.id===item.productId)?.metadata?.variants?.find(v => v.name===item.variantName);
    return qtyOf(item.productId)>=total && (!item.variantName || !!variant && variant.stock>=item.quantity);
  });
  const totalComponentCost = selectedItems.reduce((total, item) => total + (item.cost * item.quantity), 0);

  // One in-flight write at a time; see `useRunOnce`.
  const runOnce = useRunOnce();
  const saveBundle = async () => runOnce(async () => {
    try {
      const previous=await resolvePendingFinancialCommand<{product:any}>("bundle_edit");
      if(previous){
        const saved=fromRemoteRow("products",previous.product) as Product;
        useBusinessStore.setState(state=>({products:state.products.map(p=>p.id===saved.id?saved:p)}));
        editBundle(saved);
        setMessage("تم تأكيد التعديل السابق بنفس العملية. راجع البوكس المحفوظ قبل تعديل جديد.");
        return;
      }
    }catch(e){setMessage(e instanceof Error?e.message:String(e));return;}

    if (!name.trim() || !sku.trim() || !price || selectedItems.length === 0) {
      setMessage("أكمل اسم البوكس، SKU، السعر، وقم باختيار المنتجات");
      return;
    }
    const invalid=bundleDefinitionError(Number(price),selectedItems);
    if (invalid) {setMessage(invalid);return;}

    if (!editing && !selectedStockOk) {
      setMessage("لا يمكن حفظ البوكس: بعض المنتجات المختارة لا يوجد منها رصيد كافٍ بالمخزن");
      return;
    }

    // Awaited, and the form is only cleared once Supabase confirms. It used
    // to fire the write and immediately announce "تم حفظ البوكس" — so a
    // rejected write cleared the user's work and told them it was saved.
    try {
      if (editing) {
        const result = await runFinancialCommand<{product:any}>("bundle_edit", {
          productId: editing.id, before: editing.before,
          patch: {name:name.trim(),sku:sku.trim(),unitPrice:Number(price),bundleItems:selectedItems.map(item=>({
            productId:item.productId,variantName:item.variantName || undefined,quantity:item.quantity,
          }))},
        });
        const saved=fromRemoteRow("products",result.product) as Product;
        useBusinessStore.setState(state=>({products:state.products.map(p=>p.id===saved.id?saved:p)}));
      } else await addProduct({
      name: name.trim(),
      sku: sku.trim(),
      category: "بوكسات",
      unitPrice: parseFloat(price),
      wholesalePrice: parseFloat(price),
      isActive: true,
      isBundle: true,
      bundleItems: selectedItems.map(item => ({ productId: item.productId, variantName: item.variantName, quantity: item.quantity }))
    });

      clearDrafts("bundle:");
      setEditing(null);
      setName("");
      setSku("");
      setPrice("");
      setSelected({});
      setMessage("تم حفظ البوكس وربطه بالمنتجات الفردية");
    } catch(e) {
      setMessage(`تعذّر تأكيد حفظ البوكس؛ المسودة محفوظة. ${e instanceof Error?e.message:String(e)}`);
    }
  });

  const editBundle = (bundle: Product) => {
    setEditing({id:bundle.id,before:{name:bundle.name,sku:bundle.sku,unitPrice:bundle.unitPrice,
      bundleItems:bundle.bundleItems,updated_at:bundle.updated_at ?? 0}});
    setName(bundle.name);setSku(bundle.sku);setPrice(String(bundle.unitPrice));
    setSelected(Object.fromEntries((bundle.bundleItems??[]).map(c=>[`${c.productId}::${c.variantName??""}`,c.quantity])));
    setMessage("التعديل يخص البوكس في الكتالوج فقط. الفواتير وحجوزات الطلبات السابقة تحتفظ بمكوناتها وتكلفتها.");
  };
  const cancelEdit = () => {setEditing(null);setName("");setSku("");setPrice("");setSelected({});setMessage("");};

  const toggleBundle = async (id: string, currentActive: boolean) => runOnce(async () => {
    // Awaited so a refused toggle surfaces instead of becoming an unhandled
    // rejection with the switch showing a state the database never accepted.
    await updateProduct(id, { isActive: !currentActive }).catch(() => {});
  });

  const setQuantity = (key: string, quantity: number) => {
    setSelected((current) => ({ ...current, [key]: Math.max(0, quantity) }));
  };

  const handleSelectProduct = (p: Product) => {
    if (p.metadata?.variants && p.metadata.variants.length > 0) {
      setPendingVariantSelection({ product: p });
    } else {
      const key=Object.keys(selected).find(k=>k.split("::")[0]===p.id&&!k.split("::")[1])??p.id;
      setQuantity(key, (selected[key] || 0) + 1);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-display font-bold">صفحة البوكسات/التجميعات</h1>
        <p className="text-muted-foreground mt-1">
          أنشئ بوكس بسعر وسكو خاص، وسيتم خصم مخزون مكوناته تلقائياً عند البيع
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 rounded-2xl border border-border bg-card p-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-xl flex items-center justify-center bg-purple-100">
              <Boxes className="size-5 text-purple-600" />
            </div>
            <div>
              <h2 className="font-display text-xl font-bold">{editing ? "تعديل البوكس" : "منشئ البوكس"}</h2>
              <p className="text-xs text-muted-foreground">ابحث عن المنتجات وأضفها للتجميع</p>
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <Label>اسم البوكس</Label>
              <Input
                aria-label="اسم البوكس"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="مثال: بوكس العناية"
              />
            </div>
            <div>
              <Label>SKU</Label>
              <Input aria-label="SKU البوكس" value={sku} onChange={(e) => setSku(e.target.value)} placeholder="BOX-001" />
            </div>
            
            <div className="pt-2 border-t mt-4">
              <div className="flex justify-between items-center mb-1">
                <Label>سعر البوكس (سعر البيع)</Label>
                <div className="text-xs text-muted-foreground">
                  إجمالي التكلفة: <span className="font-mono font-bold text-amber-600">{formatMoney(totalComponentCost)}</span>
                </div>
              </div>
              <Input
                type="number"
                aria-label="سعر البوكس"
                min={0}
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="0"
              />
              {parseFloat(price) < totalComponentCost && (
                <p className="text-xs text-red-600 font-bold mt-1">تنبيه: سعر البيع أقل من التكلفة!</p>
              )}
            </div>
          </div>

          <div className="rounded-xl border bg-muted/30 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <Label>المكونات</Label>
              <Badge variant="outline">{selectedItems.length} منتج</Badge>
            </div>

            <div className="bg-white border rounded-lg p-2">
              <ProductSearch 
                products={products.filter(p => !p.isBundle)}
                onSelect={handleSelectProduct}
                placeholder="ابحث بالاسم، SKU أو الباركود..."
              />
            </div>

            <div className="max-h-80 overflow-y-auto space-y-2 pr-1 mt-3">
              {selectedItems.map((item) => (
                <div key={item.key} className={`rounded-lg border p-3 space-y-2 ${qtyOf(item.productId) <= 0 ? 'bg-red-50 border-red-200' : 'bg-white'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="font-medium text-sm">{item.productName}</p>
                      <p className="text-xs text-muted-foreground">
                        المخزون المتوفر: <span className={qtyOf(item.productId) <= 0 ? "text-red-600 font-bold" : ""}>{formatQty(qtyOf(item.productId))}</span>
                        {' '}— التكلفة: {formatMoney(item.cost)}
                      </p>
                      {qtyOf(item.productId) <= 0 && (
                         <p className="text-xs text-red-600 font-bold mt-1">نفد المخزون! لا يمكنك إضافة هذا المنتج.</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <Button variant="ghost" size="sm" aria-label={`حذف ${item.productName} من البوكس`} onClick={() => setSelected(current => {
                      const next={...current};delete next[item.key];return next;
                    })}><Trash2 className="size-4" /></Button>
                    <p className="text-xs font-bold font-mono text-muted-foreground">الإجمالي: {formatMoney(item.cost * item.quantity)}</p>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setQuantity(item.key, item.quantity - 1)}
                      >
                        −
                      </Button>
                      <Input
                        type="number"
                        aria-label={`كمية ${item.productName} في البوكس`}
                        min={0}
                        value={item.quantity}
                        onChange={(e) => setQuantity(item.key, parseInt(e.target.value) || 0)}
                        className="h-8 w-16 text-center"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setQuantity(item.key, item.quantity + 1)}
                      >
                        +
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
              {selectedItems.length === 0 && (
                 <p className="text-xs text-center text-muted-foreground py-4">لم تقم باختيار أي منتجات بعد</p>
              )}
            </div>
          </div>

          {message && (
            <div className={`rounded-xl border p-3 text-sm ${!selectedStockOk ? 'border-red-200 bg-red-50 text-red-800' : 'border-green-200 bg-green-50 text-green-800'}`}>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="size-4" />
                {message}
              </div>
            </div>
          )}

          <Button
            className="w-full"
            onClick={saveBundle}
            disabled={!name || !sku || !price || selectedItems.length === 0 || (!editing && !selectedStockOk)}
          >
            <Save className="size-4 ml-2" />
            {editing ? "حفظ تعديل البوكس" : "حفظ البوكس"}
          </Button>
          {editing && <Button variant="outline" onClick={cancelEdit}>إلغاء تعديل البوكس</Button>}
        </div>

        <div className="lg:col-span-2 rounded-2xl border border-border bg-card overflow-hidden">
          <div className="p-6 border-b flex items-center justify-between">
            <div>
              <h2 className="font-display text-xl font-bold">البوكسات المحفوظة</h2>
              <p className="text-xs text-muted-foreground mt-1">يتم تفكيكها إلى مكوناتها أثناء البيع</p>
            </div>
            <Badge variant="outline">{bundles.length} بوكس</Badge>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right px-4">اسم البوكس</TableHead>
                <TableHead className="text-center px-4">SKU</TableHead>
                <TableHead className="text-center px-4">السعر</TableHead>
                <TableHead className="text-center px-4">المتاح للبيع</TableHead>
                <TableHead className="text-center px-4">المكونات</TableHead>
                <TableHead className="text-center px-4">الحالة</TableHead>
                <TableHead className="text-center px-4">إجراءات</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bundles.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-12">
                    <CollectionGate tables={["products"]}>لا توجد تجميعات محفوظة</CollectionGate>
                  </TableCell>
                </TableRow>
              ) : (
                bundles.map((bundle) => (
                  <TableRow key={bundle.id}>
                    <TableCell className="px-4 font-medium">{bundle.name}</TableCell>
                    <TableCell className="text-center px-4 font-mono">{bundle.sku}</TableCell>
                    <TableCell className="text-center px-4 font-mono">
                      {formatMoney(bundle.unitPrice)}
                    </TableCell>
                    <TableCell className="text-center px-4">
                      {(() => {
                        // Derived, never stored: a بوكس has no shelf of its
                        // own, so this is entirely a fact about its components.
                        const available = bundleAvailableStock(bundle, allProducts);
                        return (
                          <Badge
                            variant={available > 0 ? "default" : "destructive"}
                            className="font-bold"
                          >
                            {formatQty(available)}
                          </Badge>
                        );
                      })()}
                    </TableCell>
                    <TableCell className="px-4">
                      <div className="flex flex-wrap justify-center gap-1">
                        {bundle.bundleItems?.map((item) => {
                          const product = allProducts.find((p) => p.id === item.productId);
                          // The component that runs out first is the one
                          // capping the box — show what each has left.
                          const onHand = getActualStock(product);
                          const short = onHand < item.quantity;
                          return (
                            <Badge
                              key={`${item.productId}::${item.variantName ?? ""}`}
                              variant={short ? "destructive" : "secondary"}
                            >
                              <Package className="size-3 ml-1" />
                              {product?.name || item.productId}
                              {item.variantName ? ` - ${item.variantName}` : ""} × {item.quantity}
                              <span className="opacity-70 mr-1">(متاح {formatQty(onHand)})</span>
                            </Badge>
                          );
                        })}
                      </div>
                    </TableCell>
                    <TableCell className="text-center px-4">
                      <Badge variant={bundle.isActive ? "default" : "secondary"}>
                        {bundle.isActive ? "نشط" : "مستبعد"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center px-4">
                      <div className="flex items-center justify-center gap-1 flex-wrap">
                        <Button variant="outline" size="sm" aria-label={`تعديل ${bundle.name}`} onClick={()=>editBundle(bundle)}>تعديل</Button>
                        <Button variant="outline" size="sm" onClick={() => toggleBundle(bundle.id, bundle.isActive ?? true)}>
                          {bundle.isActive ? "تعطيل" : "تفعيل"}
                        </Button>
                        <Button aria-label="حذف البوكس"
                          variant="ghost"
                          size="icon"
                          className="size-8 text-destructive"
                          onClick={() => removeProduct(bundle.id)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Variant Selection Modal */}
      <Dialog 
        open={pendingVariantSelection !== null} 
        onOpenChange={(open) => !open && setPendingVariantSelection(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>اختر الدرجة / اللون</DialogTitle>
            <DialogDescription>
              "{pendingVariantSelection?.product.name}" متاح بدرجات مختلفة. اختر الدرجة المطلوبة للتجميعة.
            </DialogDescription>
          </DialogHeader>
          
          <div className="grid grid-cols-2 gap-3 py-4">
            {pendingVariantSelection?.product?.metadata?.variants?.map((v: any, idx: number) => {
              const outOfStock = v.stock <= 0;
              return (
                <Button
                  key={idx}
                  variant="outline"
                  className={cn(
                    "flex flex-col items-center justify-center h-auto py-4 gap-2",
                    outOfStock && "opacity-50 grayscale"
                  )}
                  disabled={outOfStock}
                  onClick={() => {
                    if (!pendingVariantSelection) return;
                    const { product } = pendingVariantSelection;
                    setPendingVariantSelection(null);
                    setQuantity(`${product.id}::${v.name}`, (selected[`${product.id}::${v.name}`] || 0) + 1);
                  }}
                >
                  <span className="font-bold">{v.name}</span>
                  <span className="text-xs text-muted-foreground">
                    المتاح: {v.stock}
                  </span>
                </Button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
