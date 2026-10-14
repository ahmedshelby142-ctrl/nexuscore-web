/** The source ORDER snapshot, never the customer's current profile.
 * Orders persist the address as governorate + city + detail. Remove only the
 * known prefix; splitting every hyphen would change apartment/street details.
 */
export function exchangeShippingFrom(order: {
  customerId?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  governorate?: string | null;
  city?: string | null;
  address?: string | null;
}) {
  const governorate = order.governorate ?? "";
  const city = order.city ?? "";
  const address = order.address ?? "";
  const prefix = [governorate, city].filter(Boolean).join(" - ");
  const detailedAddress = prefix && address === prefix ? ""
    : prefix && address.startsWith(`${prefix} - `) ? address.slice(prefix.length + 3)
    : address;
  return {
    customerId: order.customerId ?? "",
    customerName: order.customerName ?? "",
    customerPhone: order.customerPhone ?? "",
    governorate,
    city,
    detailedAddress,
  };
}
