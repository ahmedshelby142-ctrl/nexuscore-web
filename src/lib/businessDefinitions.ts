/** Valid definition inputs; counters and historical transactions are never edited. */
export function discountDefinitionError(
  type: string,
  value: number,
  limit: string,
  expiry: string,
): string | null {
  if (
    !["fixed", "percentage"].includes(type) ||
    !Number.isFinite(value) ||
    value <= 0 ||
    (type === "percentage" && value > 100)
  )
    return "قيمة الخصم غير صالحة";
  if (limit !== "" && (!Number.isSafeInteger(Number(limit)) || Number(limit) <= 0))
    return "حد الاستخدام يجب أن يكون عددًا صحيحًا أكبر من صفر";
  if (expiry && !Number.isFinite(new Date(`${expiry}T23:59:59`).getTime()))
    return "تاريخ الانتهاء غير صالح";
  return null;
}
export function bundleDefinitionError(
  price: number,
  components: readonly { quantity: number }[],
): string | null {
  if (!Number.isFinite(price) || price <= 0) return "سعر البوكس يجب أن يكون أكبر من صفر";
  if (
    !components.length ||
    components.some((c) => !Number.isSafeInteger(c.quantity) || c.quantity <= 0)
  )
    return "اختر كميات مكونات صحيحة أكبر من صفر";
  return null;
}
