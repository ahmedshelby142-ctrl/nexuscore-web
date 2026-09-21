/**
 * الإعدادات — the account, and the way out.
 *
 * ## What belongs here, and what deliberately does not
 *
 * The audit split settings three ways: user/account preferences, store/business
 * settings, and administrative controls. Only the FIRST is a mobile surface.
 *
 * Store settings, member management, branches and licence administration are
 * ADMIN-on-Desktop in `ROUTE_ACCESS`, and the persona architecture's capability
 * matrix marks "settings · users · branches" ❌ for every persona including the
 * Owner. Putting any of them behind a phone screen every one of the five roles
 * can open would be the exact widening `MOBILE_PERSONA_ARCHITECTURE.md` §4
 * rules out. Licence state is shown by `MobileSessionGate` and
 * `LicenseExpired`, which is where an expiry belongs — it is not something a
 * member edits from here.
 *
 * So this screen is persona-neutral on purpose: who am I, how should the app
 * look, what build is this, and sign out. Those are true for ADMIN and for
 * MODERATOR alike, which is why `preferences` is the one capability all five
 * roles hold.
 *
 * ## Sign-out is not implemented here
 *
 * `signOutCurrentSession()` is the canonical path — server logout, THEN
 * `supabase.auth.signOut()`, THEN the local flag — and المزيد already calls it.
 * This screen calls the same function. There is no second auth implementation,
 * and deliberately no local-only "clear the flag" shortcut: clearing the mirror
 * while leaving the Supabase session alive is the bug `useSessionReconciliation`
 * exists to catch.
 *
 * ## Online-only
 *
 * No sync toggle, no offline mode, no conflict policy, no local accounting
 * switch. There is nothing to configure, because the server is the authority
 * and the client is a reader.
 */

import { useState } from "react";
import { ArrowRight, LogOut, Moon, Sun, UserRound } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { APP_VERSION } from "@/lib/appVersion";
import { signOutCurrentSession } from "@/lib/auth/sessionWorkflow";
import { ROLE_LABELS, toAppRole } from "@/lib/roles";
import { applyTheme } from "@/lib/theme";
import { useAuthStore } from "@/store/useAuthStore";
import { useThemeStore, type ThemeMode } from "@/store/useThemeStore";
import { MobileAppBar } from "@/mobile/components/MobileAppBar";
import { MobileSection } from "@/mobile/components/MobileSection";

const MODES: { id: ThemeMode; label: string; Icon: typeof Sun }[] = [
  { id: "light", label: "فاتح", Icon: Sun },
  { id: "dark", label: "داكن", Icon: Moon },
];

export function MobilePreferencesScreen() {
  const navigate = useNavigate();
  const username = useAuthStore((s) => s.username);
  const userRole = useAuthStore((s) => s.userRole);
  const role = toAppRole(userRole);

  const mode = useThemeStore((s) => s.mode);
  const preset = useThemeStore((s) => s.preset);
  const customColors = useThemeStore((s) => s.customColors);
  const setMode = useThemeStore((s) => s.setMode);

  const [signingOut, setSigningOut] = useState(false);

  /** Persist through the store, then repaint through the canonical applier. */
  function chooseMode(next: ThemeMode) {
    if (next === mode) return;
    setMode(next);
    applyTheme(next, preset, customColors);
  }

  async function signOut() {
    // One press. A second one during the round trip would race the redirect.
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOutCurrentSession();
    } finally {
      // `replace`, not push: the authenticated screen must not be one Back
      // press away once the session behind it is gone.
      navigate("/login", { replace: true });
    }
  }

  return (
    <section className="mobile-screen">
      <MobileAppBar
        title="الإعدادات"
        leadingAction={
          <button type="button" className="mobile-icon-button" onClick={() => navigate(-1)} aria-label="رجوع">
            <ArrowRight aria-hidden="true" />
          </button>
        }
      />

      <div className="mobile-screen-body">
        <MobileSection titleAr="الحساب">
          <div className="mobile-account-card">
            <UserRound aria-hidden="true" />
            <div>
              <p dir="ltr">{username || "—"}</p>
              <span>{ROLE_LABELS[role]}</span>
            </div>
          </div>
        </MobileSection>

        <MobileSection titleAr="المظهر">
          <div className="mobile-segmented-control" role="group" aria-label="المظهر">
            {MODES.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                aria-pressed={mode === id}
                className={mode === id ? "is-active" : ""}
                onClick={() => chooseMode(id)}
              >
                <Icon aria-hidden="true" size={16} /> {label}
              </button>
            ))}
          </div>
        </MobileSection>

        <MobileSection titleAr="عن التطبيق">
          <div className="mobile-owner-row">
            <div className="mobile-owner-row-main">
              <span className="mobile-owner-row-label">إصدار التطبيق</span>
              <span className="mobile-owner-row-value" dir="ltr">{APP_VERSION}</span>
            </div>
            <p className="mobile-owner-row-hint">
              التطبيق يعمل أونلاين فقط — كل البيانات بتتقرا من السيرفر مباشرة.
            </p>
          </div>
        </MobileSection>

        <button
          type="button"
          className="mobile-signout-button"
          onClick={() => void signOut()}
          disabled={signingOut}
          aria-busy={signingOut}
        >
          <LogOut aria-hidden="true" />
          {signingOut ? "جارٍ تسجيل الخروج…" : "تسجيل الخروج"}
        </button>
      </div>
    </section>
  );
}
