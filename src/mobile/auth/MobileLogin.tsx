import { useState } from "react";
import { Eye, EyeOff, LogIn } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { signInWithPassword } from "@/lib/auth/sessionWorkflow";
import type { BusinessProfile } from "@/types";

const profiles: { value: BusinessProfile; label: string }[] = [
  { value: "omnichannel", label: "متجر متكامل" },
  { value: "retail_only", label: "بيع مباشر" },
  { value: "ecommerce_only", label: "أونلاين" },
];

export function MobileLogin() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [businessProfile, setBusinessProfile] = useState<BusinessProfile>("omnichannel");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email.trim() || !password) {
      setError("يرجى إدخال البريد الإلكتروني وكلمة المرور.");
      return;
    }

    setError("");
    setSubmitting(true);
    try {
      const result = await signInWithPassword({
        email,
        password,
        businessProfile,
        // A mobile sign-in must never create a store or membership.
        missingMembership: "reject",
        hydrateCloudData: false,
      });
      if (!result.success) {
        setError(result.message);
        return;
      }

      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from.startsWith("/") && from !== "/login" ? from : "/", { replace: true });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="mobile-auth-page" dir="rtl">
      <section className="mobile-auth-card" aria-labelledby="mobile-login-title">
        <p className="mobile-eyebrow">NEXUS CORE</p>
        <h1 id="mobile-login-title">تسجيل دخول العمليات</h1>
        <p className="mobile-auth-description">استخدم نفس حساب NexusCore الخاص بالمتجر.</p>
        <form className="mobile-form" onSubmit={(event) => void submit(event)} noValidate>
          <label htmlFor="mobile-email">البريد الإلكتروني</label>
          <input
            id="mobile-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            dir="ltr"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={submitting}
          />
          <label htmlFor="mobile-password">كلمة المرور</label>
          <div className="mobile-password-field">
            <input
              id="mobile-password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              dir="ltr"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
            />
            <button
              type="button"
              className="mobile-icon-button"
              aria-label={showPassword ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}
              onClick={() => setShowPassword((value) => !value)}
            >
              {showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            </button>
          </div>
          <label htmlFor="mobile-profile">نوع النشاط</label>
          <select
            id="mobile-profile"
            value={businessProfile}
            onChange={(event) => setBusinessProfile(event.target.value as BusinessProfile)}
            disabled={submitting}
          >
            {profiles.map((profile) => (
              <option key={profile.value} value={profile.value}>
                {profile.label}
              </option>
            ))}
          </select>
          {error && <p className="mobile-form-error" role="alert">{error}</p>}
          <button type="submit" className="mobile-primary-button" disabled={submitting}>
            <LogIn aria-hidden="true" />
            {submitting ? "جارٍ تسجيل الدخول…" : "تسجيل الدخول"}
          </button>
        </form>
      </section>
    </main>
  );
}
