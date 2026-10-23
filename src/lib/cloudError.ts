/** Public messages use structured causes, never server SQL or arbitrary error text. */
export function cloudErrorMessage(error: unknown, subject = "البيانات"): string {
  const e = error as { code?: string; status?: number; message?: string } | null;
  const code = String(e?.code ?? ""),
    message = String(e?.message ?? "");
  if (code === "STALE_AUTHORITY")
    return "تغيّرت صلاحيات الجلسة؛ أعد تحميل البيانات بالحساب الحالي.";
  if (
    e?.status === 401 ||
    /^PGRST30[123]$/.test(code) ||
    /jwt.*expired|invalid.*jwt/i.test(message)
  )
    return "انتهت جلسة الدخول. سجّل الدخول مجددًا.";
  if (
    e?.status === 403 ||
    code === "42501" ||
    /permission denied|FORBIDDEN|row-level security/i.test(message)
  )
    return `ليس لديك صلاحية تحميل ${subject}. راجع مدير المتجر.`;
  if (/^(42P01|42703|42883|PGRST20[245])$/.test(code))
    return `تعذّر تحميل ${subject} بسبب عدم توافق إصدار الخدمة. تواصل مع الدعم.`;
  if (e?.status === 429 || code === "53300")
    return "الخادم مشغول حاليًا. انتظر قليلًا ثم أعد المحاولة.";
  if (e?.status === 504 || code === "57014" || /timeout|timed out/i.test(message))
    return `انتهت مهلة تحميل ${subject}. حاول مرة أخرى.`;
  if (
    /failed to fetch|networkerror|network request failed/i.test(message) ||
    (typeof navigator !== "undefined" && navigator.onLine === false)
  )
    return "تعذّر الاتصال مؤقتًا بالخادم. تحقّق من الإنترنت ثم حاول مرة أخرى.";
  return `تعذّر تحميل ${subject}. حاول مرة أخرى.`;
}
