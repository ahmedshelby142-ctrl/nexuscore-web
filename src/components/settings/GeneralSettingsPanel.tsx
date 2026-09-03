import { useState } from "react";
import { useSubmitGate } from "@/hooks/useSubmitGate";
import { useSettingsStore } from "@/store/useSettingsStore";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Store, Loader2, Save } from "lucide-react";

export function GeneralSettingsPanel() {
  const {
    storeName,
    storeLogoUrl,
    phoneNumber,
    address,
    taxNumber,
    vatRate,
    updateSettings,
    pushSettings,
  } = useSettingsStore();

  const [isSaving, setIsSaving] = useState(false);
  // One submit at a time; state cannot close the same-tick window.
  const gate = useSubmitGate();
  const [saveMessage, setSaveMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const handleSave = async () => {
    if (!gate.enter()) return;
    setIsSaving(true);
    setSaveMessage(null);
    try {
      await pushSettings();
      setSaveMessage({ type: "success", text: "تم حفظ التغييرات بنجاح" });
    } catch (e) {
      console.error(e);
      setSaveMessage({ type: "error", text: "حدث خطأ أثناء حفظ التغييرات" });
    } finally {
      setIsSaving(false);
      gate.exit();
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Store Information */}
        <div className="space-y-4">
          <h3 className="text-lg font-medium flex items-center gap-2">
            <Store className="size-5 text-primary" />
            بيانات المحل الأساسية
          </h3>
          
          <div className="space-y-2">
            <Label htmlFor="storeName">اسم المحل</Label>
            <Input
              id="storeName"
              value={storeName}
              onChange={(e) => updateSettings({ storeName: e.target.value })}
              placeholder="مثال: راديانت للأزياء"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="storeLogoUrl">شعار المحل (رابط الصورة)</Label>
            <Input
              id="storeLogoUrl"
              value={storeLogoUrl}
              onChange={(e) => updateSettings({ storeLogoUrl: e.target.value })}
              placeholder="https://example.com/logo.png"
              className="direction-ltr text-left"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="phoneNumber">رقم الهاتف</Label>
            <Input
              id="phoneNumber"
              value={phoneNumber}
              onChange={(e) => updateSettings({ phoneNumber: e.target.value })}
              placeholder="01xxxxxxxxx"
              className="direction-ltr text-left"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="address">العنوان</Label>
            <Input
              id="address"
              value={address}
              onChange={(e) => updateSettings({ address: e.target.value })}
              placeholder="مثال: القاهرة، مدينة نصر"
            />
          </div>
        </div>

        {/* Tax Settings */}
        <div className="space-y-4">
          <h3 className="text-lg font-medium">الإعدادات الضريبية</h3>
          
          <div className="space-y-2">
            <Label htmlFor="taxNumber">الرقم الضريبي</Label>
            <Input
              id="taxNumber"
              value={taxNumber}
              onChange={(e) => updateSettings({ taxNumber: e.target.value })}
              placeholder="xxx-xxx-xxx"
              className="direction-ltr text-left"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="vatRate">نسبة الضريبة الافتراضية (%)</Label>
            <Input
              id="vatRate"
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={vatRate}
              onChange={(e) => updateSettings({ vatRate: parseFloat(e.target.value) || 0 })}
            />
          </div>
        </div>
      </div>

      <div className="pt-4 border-t border-border flex items-center justify-between">
        <div className="text-sm">
          {saveMessage && (
            <span className={saveMessage.type === "success" ? "text-green-600 dark:text-green-400" : "text-destructive"}>
              {saveMessage.text}
            </span>
          )}
        </div>
        <Button onClick={handleSave} disabled={isSaving} className="gap-2 px-8">
          {isSaving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          حفظ التغييرات
        </Button>
      </div>
    </div>
  );
}
