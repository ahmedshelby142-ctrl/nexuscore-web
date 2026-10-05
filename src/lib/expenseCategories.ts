import type { BusinessPersona, ExpenseCategory } from "@/types";
export const EXPENSE_CATEGORIES: Record<
  BusinessPersona,
  { value: ExpenseCategory; label: string }[]
> = {
  retail: [
    { value: "store_rent", label: "إيجار الفروع" },
    { value: "shipping", label: "مصاريف شحن وتوصيل" },
    { value: "marketing", label: "تسويق وإعلانات" },
    { value: "office_supplies", label: "نثريات وضيافة" },
    { value: "utilities", label: "فواتير" },
    { value: "transport", label: "نقل" },
    { value: "maintenance", label: "صيانة" },
    { value: "other", label: "أخرى" },
  ],
  ecommerce: [
    { value: "shipping", label: "مصاريف شحن وتوصيل" },
    { value: "marketing", label: "تسويق وإعلانات" },
    { value: "office_supplies", label: "نثريات وضيافة" },
    { value: "utilities", label: "فواتير" },
    { value: "transport", label: "نقل" },
    { value: "maintenance", label: "صيانة" },
    { value: "other", label: "أخرى" },
  ],
};
