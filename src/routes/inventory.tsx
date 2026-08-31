import { InventoryTable } from "@/components/inventory/InventoryTable";
import { ShortagesReport } from "@/components/inventory/ShortagesReport";

export function Inventory() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-display font-bold mb-2">إدارة المخزون</h2>
        <p className="text-muted-foreground">مراقبة المخزون وتحديث الكميات بشكل مركزي</p>
      </div>

      <InventoryTable />

      {/* What the open orders need that the shelf cannot cover. */}
      <ShortagesReport />
    </div>
  );
}
