import { InventoryTable } from "@/components/inventory/InventoryTable";

export function Inventory() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-display font-bold mb-2">إدارة المخزون</h2>
        <p className="text-muted-foreground">مراقبة المخزون وتحديث الكميات بشكل مركزي</p>
      </div>

      <InventoryTable />
    </div>
  );
}
