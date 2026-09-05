/**
 * The shipping price matrix: governorate × movement.
 *
 * This is the ONLY place a shipping fee comes from. It replaces 26 hardcoded
 * governorate fees and a seeded 65/45 tariff — prices the owner had never
 * agreed to, quoted to customers by default.
 *
 * The three columns are priced separately because they are three different
 * jobs, and the labels say who pays, because that is the part that gets a shop
 * shortchanged: a return is the only one the shop bears.
 */

import { useRunOnce } from "@/hooks/useSubmitGate";
import { useState } from "react";
import { Plus, Trash2, Info } from "lucide-react";
import { useShippingRatesStore } from "@/store/useShippingRatesStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function ShippingRateMatrix() {
  const { rows, addRow, updateRow, removeRow } = useShippingRatesStore();
  const [newGovernorate, setNewGovernorate] = useState("");

  // Cloud writes since migration 018, so these are awaited — and gated, or a
  // double click files the same governorate twice and the second one dies on
  // the unique index instead of being ignored.
  const runOnce = useRunOnce();

  const add = () =>
    runOnce(async () => {
      const name = newGovernorate;
      try {
        await addRow(name);
        setNewGovernorate("");
      } catch {
        /* the store announced it; leave the typed name for a retry */
      }
    });

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-blue-200 bg-blue-50 dark:bg-blue-950/20 dark:border-blue-900 p-4">
        <div className="flex items-start gap-3">
          <Info className="size-5 text-blue-600 mt-0.5 shrink-0" />
          <div className="text-sm text-blue-900 dark:text-blue-200 space-y-1">
            <p className="font-semibold">مين بيدفع إيه</p>
            <p>
              <strong>التوصيل</strong> و<strong>الاستبدال</strong> — العميل هو اللي بيدفعهم، وإحنا
              بنمرّرهم للمندوب. مش مصاريف علينا.
            </p>
            <p>
              <strong>المرتجع</strong> — إحنا اللي بندفعه. ده المصروف الوحيد اللي بيتحسب علينا في
              الشحن.
            </p>
            <p className="text-xs opacity-80">
              السعر بيتسجّل مع الحركة وقت ما تحصل. لو غيّرت السعر بعدين، الشحنات القديمة بتفضل
              بسعرها.
            </p>
          </div>
        </div>
      </div>

      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="newGov">إضافة محافظة</Label>
          <Input
            id="newGov"
            value={newGovernorate}
            onChange={(e) => setNewGovernorate(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder="اسم المحافظة"
          />
        </div>
        <Button onClick={add} disabled={!newGovernorate.trim()}>
          <Plus className="size-4 ml-1" />
          إضافة
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">
          لسه مفيش أسعار شحن. ضيف محافظة وحدّد سعر التوصيل والمرتجع والاستبدال — من غير كده مش
          هيتحسب أي رسم شحن.
        </p>
      ) : (
        <div className="rounded-md border border-border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right px-4">المحافظة</TableHead>
                <TableHead className="text-center px-4">توصيل (العميل يدفع)</TableHead>
                <TableHead className="text-center px-4">مرتجع (إحنا ندفع)</TableHead>
                <TableHead className="text-center px-4">استبدال (العميل يدفع)</TableHead>
                <TableHead className="text-center px-4">حذف</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium px-4 whitespace-nowrap">
                    {row.governorate}
                  </TableCell>
                  {(["delivery", "return", "exchange"] as const).map((movement) => (
                    <TableCell key={movement} className="text-center px-4">
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={row[movement] || ""}
                        onChange={(e) =>
                          void updateRow(row.id, { [movement]: parseFloat(e.target.value) || 0 })
                        }
                        className={
                          "w-24 mx-auto text-center " +
                          (movement === "return" ? "border-red-200" : "")
                        }
                        placeholder="0"
                      />
                    </TableCell>
                  ))}
                  <TableCell className="text-center px-4">
                    <Button aria-label="حذف تعريفة الشحن"
                      variant="ghost"
                      size="icon"
                      className="size-8 text-destructive"
                      onClick={() => void removeRow(row.id)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
