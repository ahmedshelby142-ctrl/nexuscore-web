import { useEffect, useState } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { authLinkIntent } from "@/lib/auth/authLinkIntent";
import { completePasswordSetup, readPasswordSetupSession } from "@/lib/auth/sessionWorkflow";

export function MobileSetPassword() {
  const navigate = useNavigate();
  // Captured before supabase-js cleared the fragment (`authLinkIntent.ts`).
  const intent = authLinkIntent();
  const [email, setEmail] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void readPasswordSetupSession().then((session) => {
      if (cancelled) return;
      // A failed/expired link must not fall through to a form for whatever
      // session this browser already had.
      setEmail(intent === "link_error" ? null : session.email);
      setError(session.error ?? "");
      setChecking(false);
    });
    return () => {
      cancelled = true;
    };
  }, [intent]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (password !== confirmation) {
      setError("الباسوردين مش زي بعض.");
      return;
    }

    setError("");
    setSaving(true);
    try {
      const result = await completePasswordSetup(password);
      if (!result.success) {
        setError(result.message);
        return;
      }
      navigate("/", { replace: true });
    } finally {
      setSaving(false);
    }
  };

  if (checking) return <main className="mobile-state">جارٍ التحقق من الرابط…</main>;

  if (!email) {
    return (
      <main className="mobile-state" dir="rtl">
        <ShieldCheck className="mobile-license-icon" aria-hidden="true" />
        <h1>{intent === "link_error" ? "الرابط انتهى أو اتستخدم قبل كده" : "الرابط غير صالح"}</h1>
        <p>{error || "افتح رابط الدعوة أو الاسترداد من البريد الإلكتروني، أو اطلب رابط جديد من «نسيت كلمة المرور؟»."}</p>
        <button type="button" className="mobile-primary-button" onClick={() => navigate("/login", { replace: true })}>
          الذهاب لتسجيل الدخول
        </button>
      </main>
    );
  }

  return (
    <main className="mobile-auth-page" dir="rtl">
      <section className="mobile-auth-card" aria-labelledby="mobile-password-title">
        <KeyRound className="mobile-placeholder-icon" aria-hidden="true" />
        <h1 id="mobile-password-title">{intent === "recovery" ? "تغيير كلمة المرور" : "إنشاء كلمة المرور"}</h1>
        <p className="mobile-auth-description" dir="ltr">{email}</p>
        <form className="mobile-form" onSubmit={(event) => void submit(event)}>
          <label htmlFor="mobile-new-password">كلمة المرور الجديدة</label>
          <input
            id="mobile-new-password"
            type="password"
            autoComplete="new-password"
            dir="ltr"
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={saving}
          />
          <label htmlFor="mobile-password-confirmation">تأكيد كلمة المرور</label>
          <input
            id="mobile-password-confirmation"
            type="password"
            autoComplete="new-password"
            dir="ltr"
            minLength={8}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            disabled={saving}
          />
          {error && <p className="mobile-form-error" role="alert">{error}</p>}
          <button type="submit" className="mobile-primary-button" disabled={saving}>
            {saving ? "جارٍ الحفظ…" : "حفظ والدخول"}
          </button>
        </form>
      </section>
    </main>
  );
}
