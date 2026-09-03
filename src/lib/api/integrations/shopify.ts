/**
 * Shopify / WooCommerce Intake Integration Scaffold
 */

export interface ShopifyCredentials {
  storeUrl: string;
  apiKey: string;
  apiSecret?: string;
}

/**
 * NOT A CLIENT. Nothing here contacts the storefront.
 *
 * `testConnection` used to answer "تم الاتصال بخوادم the store بنجاح!" after a
 * `setTimeout` and a string check — a success message for a call that was
 * never made, which is the one thing this codebase does not allow a screen to
 * say. It now reports exactly what it did: it looked at the shape of the
 * fields.
 *
 * Wiring this up for real needs a server-side caller, because the credential
 * must not be in the browser. See `docs/INTEGRATIONS.md`.
 */
export async function testConnection(credentials: ShopifyCredentials): Promise<{ ok: boolean; msg: string }> {
  // Simulate network delay
  await new Promise(resolve => setTimeout(resolve, 800));
  
  if (!credentials.storeUrl) {
    return { ok: false, msg: "أدخل رابط المتجر للتحقق" };
  }

  // Very basic simulated validation
  if (!credentials.storeUrl.startsWith("http")) {
    return { ok: false, msg: "رابط المتجر غير صالح. يجب أن يبدأ بـ http:// أو https://" };
  }

  return {
    ok: true,
    msg: "الحقول شكلها مظبوط. ملاحظة: لسه مفيش اتصال فعلي بالمتجر — الربط محتاج طبقة خادم.",
  };
}

/**
 * Scaffolds fetching an order from the remote store.
 */
export async function fetchOrder(orderId: string, credentials: ShopifyCredentials): Promise<any> {
  // Scaffold implementation
  await new Promise(resolve => setTimeout(resolve, 300));
  return null;
}
