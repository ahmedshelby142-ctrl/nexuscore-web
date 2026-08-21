import sys
import os
import re

file_path = "src/routes/returns.tsx"

with open(file_path, "r", encoding="utf-8") as f:
    content = f.read()

# 1. Imports
content = content.replace(
    """  Phone,
  Hash,
  Printer,""",
    """  Phone,
  Hash,
  Printer,
  Loader2,
  Inbox,"""
)

if "import { toast } from" not in content:
    content = content.replace(
        "import { cn } from \"@/lib/utils\";",
        "import { cn } from \"@/lib/utils\";\nimport { toast } from \"sonner\";\nimport { EmptyState } from \"@/components/ui/empty-state\";"
    )

# 2. State removal
content = content.replace(
    'const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);',
    ''
)
content = content.replace(
    'const [actionError, setActionError] = useState<string | null>(null);',
    ''
)

# 3. actionError -> toast.error
content = content.replace('setActionError("الطلب مش في حالة مرتجع — مفيش مرتجع يتأكد استلامه.");', 'toast.error("الطلب مش في حالة مرتجع — مفيش مرتجع يتأكد استلامه.");')
content = content.replace('setActionError("جاري المعالجة");', 'toast.error("جاري المعالجة");')
content = content.replace('setActionError("المرتجع ده اتأكد استلامه قبل كده — المخزون رجع والفلوس اترجّعت.");', 'toast.error("المرتجع ده اتأكد استلامه قبل كده — المخزون رجع والفلوس اترجّعت.");')
content = content.replace('setActionError("اسم العميل غير مطابق — اكتب الاسم زي ما هو في الطلب للتأكيد");', 'toast.error("اسم العميل غير مطابق — اكتب الاسم زي ما هو في الطلب للتأكيد");')
content = content.replace('setActionError(null);', '')
content = content.replace('setActionError(`فشل التأكيد: ${e instanceof Error ? e.message : String(e)}`);', 'toast.error(`فشل التأكيد: ${e instanceof Error ? e.message : String(e)}`);')

# 4. result -> toast
content = content.replace('setResult({ success: false, message: "اختر منتج واحد على الأقل للإرجاع" });', 'toast.error("اختر منتج واحد على الأقل للإرجاع");')
content = content.replace('setResult({ success: false, message: "اختر المنتج البديل وحدد الكمية" });', 'toast.error("اختر المنتج البديل وحدد الكمية");')
content = content.replace("""      setResult({
        success: false,
        message: `الكمية المطلوبة من "${exchangeProduct?.name ?? ""}" أكبر من المخزون (${qtyOf(exchange_product_id)})`,
      });""", """      toast.error(
        `الكمية المطلوبة من "${exchangeProduct?.name ?? ""}" أكبر من المخزون (${qtyOf(exchange_product_id)})`
      );""")
content = content.replace('setResult(null);', '')
content = content.replace("""      setResult({
        success: false,
        message: `لم يُسجَّل المرتجع ولم يتغيّر المخزون. ${e instanceof Error ? e.message : String(e)}`,
      });""", """      toast.error(
        `لم يُسجَّل المرتجع ولم يتغيّر المخزون. ${e instanceof Error ? e.message : String(e)}`
      );""")
content = content.replace("""        setResult({
          success: false,
          message: `تم تسجيل الإرجاع، لكن المنتج البديل لم يُسجَّل. العملية مسجّلة كـ "بديل معلّق" تحت — لازم تسجّله كبيع. ${e instanceof Error ? e.message : String(e)}`,
        });""", """        toast.error(
          `تم تسجيل الإرجاع، لكن المنتج البديل لم يُسجَّل. العملية مسجّلة كـ "بديل معلّق" تحت — لازم تسجّله كبيع. ${e instanceof Error ? e.message : String(e)}`
        );""")
content = content.replace("""    setResult({
      success: true,
      message: exchangeMode
        ? `تمت عملية الاستبدال بنجاح! ${
            priceDiff >= 0
              ? `العميل يدفع فرق ${priceDiff.toLocaleString("ar-EG")} ج.م`
              : `العميل يسترد ${Math.abs(priceDiff).toLocaleString("ar-EG")} ج.م`
          }`
        : "تم تسجيل الإرجاع بنجاح!",
    });""", """    toast.success(
      exchangeMode
        ? `تمت عملية الاستبدال بنجاح! ${
            priceDiff >= 0
              ? `العميل يدفع فرق ${priceDiff.toLocaleString("ar-EG")} ج.م`
              : `العميل يسترد ${Math.abs(priceDiff).toLocaleString("ar-EG")} ج.م`
          }`
        : "تم تسجيل الإرجاع بنجاح!"
    );""")
content = content.replace('setTimeout(() => setResult(null), 5000);', '')

# 5. Remove result block rendering
content = re.sub(r'\{result && \(\s*<div.*?</p>\s*</div>\s*\)\}', '', content, flags=re.DOTALL)

# 6. Remove actionError block rendering
content = re.sub(r'\{actionError && \(\s*<div.*?</p>\s*</div>\s*\)\}', '', content, flags=re.DOTALL)

# 7. Add Loader2 to handleReturn
content = content.replace("""          <Button onClick={handleReturn} className="w-full" size="lg">
            {exchangeMode ? (
              <>
                <ArrowLeftRight className="size-4 ml-2" /> تأكيد الاستبدال وحساب الفرق
              </>
            ) : (
              <>
                <RotateCcw className="size-4 ml-2" /> تأكيد الإرجاع وإعادة المخزون
              </>
            )}
          </Button>""", """          <Button onClick={handleReturn} className="w-full" size="lg" disabled={isWorking}>
            {isWorking ? (
              <Loader2 className="h-4 w-4 animate-spin ml-2" />
            ) : exchangeMode ? (
              <ArrowLeftRight className="size-4 ml-2" />
            ) : (
              <RotateCcw className="size-4 ml-2" />
            )}
            {isWorking ? "جاري التأكيد..." : exchangeMode ? "تأكيد الاستبدال وحساب الفرق" : "تأكيد الإرجاع وإعادة المخزون"}
          </Button>""")

# 8. Add Loader2 to handleConfirmCourierReturn
content = content.replace("""            <Button onClick={handleConfirmCourierReturn} disabled={isWorking}>
              {isWorking ? "جاري التأكيد..." : "تأكيد واسترجاع للمخزن"}
            </Button>""", """            <Button onClick={handleConfirmCourierReturn} disabled={isWorking}>
              {isWorking && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isWorking ? "جاري التأكيد..." : "تأكيد واسترجاع للمخزن"}
            </Button>""")

# 9. Empty states
content = content.replace("""        {useBusinessStore.getState().returnRecords.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            لا توجد عمليات إرجاع أو استبدال حتى الآن
          </p>
        ) : (""", """        {useBusinessStore.getState().returnRecords.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="لا توجد عمليات إرجاع أو استبدال حتى الآن"
            className="py-12"
          />
        ) : (""")

content = content.replace("""            {returnedOrders.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                مفيش أوردرات معلقة في حالة مرتجع حاليا.
              </p>
            ) : (""", """            {returnedOrders.length === 0 ? (
              <EmptyState
                icon={Inbox}
                title="مفيش أوردرات معلقة في حالة مرتجع حاليا"
                className="py-12"
              />
            ) : (""")


with open(file_path, "w", encoding="utf-8") as f:
    f.write(content)
print("Done")
