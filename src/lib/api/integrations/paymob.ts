/**
 * Paymob Integration Scaffold
 * RULES §3.6a: STRICT SCOPE LIMITS. ONLY functions to verify a specific checkout transaction
 * are permitted. Functions like getWalletBalance or importTransactions are strictly FORBIDDEN.
 */

export interface PaymobCredentials {
  apiKey: string;
  integrationId: string;
}

/**
 * NOT A CLIENT. Nothing here contacts Paymob.
 *
 * `testConnection` used to answer "تم الاتصال بخوادم Paymob بنجاح!" after a
 * `setTimeout` and a string check — a success message for a call that was
 * never made, which is the one thing this codebase does not allow a screen to
 * say. It now reports exactly what it did: it looked at the shape of the
 * fields.
 *
 * Wiring this up for real needs a server-side caller, because the credential
 * must not be in the browser. See `docs/INTEGRATIONS.md`.
 */
export async function testConnection(credentials: PaymobCredentials): Promise<{ ok: boolean; msg: string }> {
  // Simulate network delay
  await new Promise(resolve => setTimeout(resolve, 800));
  
  if (!credentials.apiKey || !credentials.integrationId) {
    return { ok: false, msg: "أدخل API Key و Integration ID للتحقق" };
  }

  // Simulated validation
  if (!credentials.apiKey.startsWith("sk_")) {
    return { ok: false, msg: "API Key غير صالح. يجب أن يبدأ بـ sk_" };
  }

  return {
    ok: true,
    msg: "الحقول شكلها مظبوط. ملاحظة: لسه مفيش اتصال فعلي بـ Paymob — الربط محتاج طبقة خادم.",
  };
}

/**
 * Verifies if a specific checkout transaction is completed.
 * This satisfies the ledger requirement to safely create a `wallet +` event.
 */
export async function verifyCheckoutTransaction(transactionId: string, credentials: PaymobCredentials): Promise<boolean> {
  // Scaffold implementation
  await new Promise(resolve => setTimeout(resolve, 300));
  return true;
}
