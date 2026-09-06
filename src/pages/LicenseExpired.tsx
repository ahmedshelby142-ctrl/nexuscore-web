import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useStoreLicense } from "@/store/useStoreLicense";
import { isUsable } from "@/lib/license/evaluate";
import { useAuthStore } from "@/store/useAuthStore";
import logoDark from "@/assets/logo-dark.png";

/**
 * The lockout screen.
 *
 * Two things it must get right, both of them about trust rather than pixels:
 *
 * 1. It tells the shop their DATA IS SAFE and still syncing. A screen that just
 *    says "expired" invites the owner to reinstall, restore a backup, or start
 *    re-keying today's sales into a notebook — all of which lose money that is
 *    sitting safely in the ledger.
 * 2. It separates "your licence ran out" from "we could not check". Accusing a
 *    paying customer of non-payment because our own server was unreachable is
 *    the worst thing this screen could do.
 */
export function LicenseExpired() {
  const navigate = useNavigate();
  const { decision, row, refresh, checking, resolved, hydrate } = useStoreLicense();
  const logout = useAuthStore((s) => s.logout);
  const [retried, setRetried] = useState(false);

  /**
   * Ask, before saying anything.
   *
   * `LicenseGate` is what normally fetches the verdict, and it is NOT mounted
   * on this route — it cannot be, or it would redirect to a route it blocks.
   * So a browser that lands here directly (a bookmark, a refresh while locked
   * out, the tab restored after a crash) had nothing in the store at all, and
   * the screen read the empty state as `unverified` and told the customer
   * "تعذّر التحقق من الترخيص" — before it had asked anything.
   *
   * Accusing our own server of being unreachable when nobody dialled it is
   * exactly the failure this screen's header warns about, one level down.
   */
  useEffect(() => {
    if (!resolved) {
      hydrate();
      void refresh();
    }
  }, [resolved, hydrate, refresh]);

  /**
   * One row of copy per verdict, rather than ternaries nested three deep.
   *
   * The four states are genuinely four different messages, and the failure
   * mode this replaces is exactly the one this file's header warns about: the
   * screen used to collapse them and tell a brand-new signup — and later a
   * suspended shop — "انتهت صلاحية الترخيص". An owner told their licence
   * expired reasonably reaches for a reinstall or a backup restore to "get
   * their data back", when nothing was ever lost and nothing ran out.
   *
   *   unlicensed → the account and shop exist; activation is pending.
   *   suspended  → the system owner switched access off; data is untouched.
   *   expired    → the paid period ended; renew it.
   *   unverified → we could not check. Not an accusation.
   *
   * No policy is decided here. Whether a new shop gets a trial or waits for
   * manual activation is a business decision this screen does not make; it
   * only stops claiming an expiry that never happened.
   */
  const verdict = decision?.verdict ?? "unverified";

  const COPY = {
    unlicensed: {
      tone: "amber" as const,
      icon: "clock" as const,
      title: "المتجر لسه متفعّلش",
      body: "الحساب والمتجر اتعملوا بنجاح، وبياناتك كلها في مكانها. لسه محتاج تفعيل الاشتراك عشان تقدر تستخدم الشاشات — كلّم الدعم وهيتفعّل.",
      retry: "لسه مفيش تفعيل للمتجر ده. تواصل مع الدعم لتفعيل الاشتراك.",
    },
    suspended: {
      tone: "amber" as const,
      icon: "lock" as const,
      title: "تم إيقاف الوصول مؤقتاً",
      body: "إدارة النظام أوقفت الوصول لهذا المتجر. ده إيقاف للدخول فقط — مفيش أي بيانات اتحذفت، والفواتير والمخزون والحسابات كلها زي ما هي. تواصل مع إدارة النظام لإعادة التفعيل.",
      retry: "الوصول ما زال موقوفاً. تواصل مع إدارة النظام لإعادة التفعيل.",
    },
    expired: {
      tone: "red" as const,
      icon: "lock" as const,
      title: "انتهت صلاحية الترخيص",
      body: decision?.messageAr ?? "انتهت صلاحية ترخيص المتجر.",
      retry: "ما زال الترخيص غير ساري. تواصل مع الدعم لتجديد الاشتراك.",
    },
    unverified: {
      tone: "amber" as const,
      icon: "warn" as const,
      title: "تعذّر التحقق من الترخيص",
      body: decision?.messageAr ?? "تعذّر التحقق من الترخيص. تأكد من الاتصال بالإنترنت.",
      retry: "ما زال التحقق متعذّراً. تأكد من الاتصال بالإنترنت.",
    },
    ok: {
      tone: "amber" as const,
      icon: "warn" as const,
      title: "الترخيص ساري",
      body: "يمكنك العودة إلى التطبيق.",
      retry: "",
    },
  }[verdict];

  const amber = COPY.tone === "amber";

  /**
   * Poll while the lockout is on screen.
   *
   * The customer is on the phone to the administrator when they are looking at
   * this. Making them press a button after the administrator says "done" is a
   * second support call; a check a minute costs one row and closes the loop by
   * itself.
   */
  useEffect(() => {
    const t = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  /**
   * A licence that came back good sends the shop straight back to work.
   *
   * This screen lives OUTSIDE `LicenseGate` — it has to, or the gate would
   * redirect to a route the gate itself blocks — so nothing else was checking
   * whether the lockout still applied once it rendered. Two ways in end here
   * with a valid licence:
   *
   *   1. Reactivation. The owner switches the shop back on while the screen is
   *      open; the periodic re-check lands a good verdict and the customer is
   *      left reading a lockout that no longer applies.
   *   2. A stale cache. `hydrate()` paints the last known verdict before the
   *      network answers, so a shop suspended yesterday and reinstated this
   *      morning gets one frame of "suspended", is redirected here, and then
   *      the fresh verdict arrives — too late, the redirect already happened.
   *
   * In both cases the shop is licensed and locked out of its own app. This is
   * the way back, and it costs a redirect nobody licensed will ever see.
   *
   * `decision === null` means licensing is not enforced in this build (no
   * Supabase configured); there is nothing to lock, so the same applies.
   *
   * KEEP THIS BELOW EVERY HOOK. It was written above them the first time and
   * the screen died with React error #300 — "rendered fewer hooks than
   * expected" — the moment the verdict came back good, which is precisely the
   * case this early return exists to serve. Guarded in check_license_gate.mjs.
   */
  if (resolved && (!decision || isUsable(decision.verdict))) {
    return <Navigate to="/" replace />;
  }

  // Nothing checked yet. Say that, rather than picking a verdict at random.
  if (!resolved) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#0B1220]">
        <div className="flex flex-col items-center gap-4">
          <div className="size-8 rounded-full border-2 border-[#06B6D4] border-t-transparent animate-spin" />
          <p className="text-sm text-white/60">جارٍ التحقق من الترخيص…</p>
        </div>
      </div>
    );
  }

  const handleRetry = async () => {
    await refresh();
    setRetried(true);
    // If the licence was renewed while this screen was open, the gate lets the
    // user straight back in; navigating home is what triggers that re-check.
    navigate("/", { replace: true });
  };

  return (
    <div
      dir="rtl"
      className="min-h-screen bg-[#0B1220] flex items-center justify-center p-4 relative overflow-hidden"
    >
      <div
        className="absolute inset-0 opacity-[0.035]"
        style={{
          backgroundImage:
            "linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)",
          backgroundSize: "56px 56px",
        }}
      />

      <div className="relative w-full max-w-[520px] rounded-3xl overflow-hidden border border-[#1E293B] bg-[#111C2E]/90 backdrop-blur-2xl shadow-2xl shadow-black/40">
        <div className="p-8 sm:p-10 space-y-7">
          <div className="flex items-center gap-3">
            <img src={logoDark} alt="NexusCore" className="size-10 object-contain" />
            <div>
              <h1 className="text-xl font-bold text-white font-display tracking-tight">
                NexusCore
              </h1>
              <p className="text-[11px] text-white/50 tracking-widest mt-0.5">
                منظومة إدارة المؤسسات
              </p>
            </div>
          </div>

          <div className="flex flex-col items-center text-center gap-4 pt-2">
            <div
              className={`size-16 rounded-2xl flex items-center justify-center ${
                amber ? "bg-amber-500/10" : "bg-red-500/10"
              }`}
            >
              <svg
                className={`size-8 ${amber ? "text-amber-400" : "text-red-400"}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.6}
              >
                {COPY.icon === "warn" && (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 9v3.75m0 3.75h.007M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                )}
                {COPY.icon === "clock" && (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 6v6l4 2m5-2a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                )}
                {COPY.icon === "lock" && (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75A2.25 2.25 0 004.5 12.75v6.75A2.25 2.25 0 006.75 21z"
                  />
                )}
              </svg>
            </div>

            <div className="space-y-2">
              <h2 className="text-2xl font-bold text-white">{COPY.title}</h2>
              <p className="text-sm text-white/60 leading-relaxed">{COPY.body}</p>
            </div>
          </div>

          {/* The reassurance. Nothing on this screen matters more than this
              box: it is what stops a panicked owner from reinstalling. */}
          <div className="rounded-2xl border border-[#1E293B] bg-[#0B1220]/60 p-4 space-y-2.5">
            <div className="flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-[#06B6D4] shadow-[0_0_8px_rgba(6,182,212,0.8)]" />
              <p className="text-[13px] font-semibold text-white/85">بياناتك محفوظة بالكامل</p>
            </div>
            <p className="text-[12.5px] text-white/55 leading-relaxed">
              كل الفواتير والمخزون والحسابات محفوظة على السحابة، وليست على هذا
              الجهاز. لا شيء ينتظر الرفع ولا شيء معرّض للضياع — بمجرد تجديد
              الترخيص ستجد بياناتك كما تركتها بالضبط.
            </p>
          </div>

          {row && (
            <dl className="grid grid-cols-2 gap-3 text-[12.5px]">
              <div className="rounded-xl border border-[#1E293B] bg-[#0B1220]/40 p-3">
                <dt className="text-white/40 mb-1">الباقة</dt>
                <dd className="text-white/80 font-medium">{row.plan_type}</dd>
              </div>
              <div className="rounded-xl border border-[#1E293B] bg-[#0B1220]/40 p-3">
                {/* A suspended licence has NOT expired — its date is usually
                    still in the future. Calling that "تاريخ الانتهاء" next to a
                    lockout invites the owner to conclude it lapsed. */}
                <dt className="text-white/40 mb-1">
                  {verdict === "suspended" ? "صالح حتى" : "تاريخ الانتهاء"}
                </dt>
                <dd className="text-white/80 font-medium">
                  {new Date(row.valid_until).toLocaleDateString("ar-EG", {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  })}
                </dd>
              </div>
            </dl>
          )}

          <div className="space-y-3">
            <button
              onClick={handleRetry}
              disabled={checking}
              className="w-full h-11 rounded-xl bg-[#06B6D4] hover:bg-[#0891B2] disabled:opacity-50 text-[#062B33] font-semibold text-sm transition-colors"
            >
              {checking ? "جارٍ التحقق…" : "إعادة المحاولة"}
            </button>

            {retried && !checking && COPY.retry && (
              <p className="text-center text-[12px] text-white/40">{COPY.retry}</p>
            )}

            <button
              onClick={() => {
                logout();
                navigate("/login", { replace: true });
              }}
              className="w-full h-11 rounded-xl border border-[#1E293B] text-white/70 hover:text-white hover:border-white/25 text-sm transition-colors"
            >
              تسجيل الخروج
            </button>
          </div>

          <p className="text-center text-[11px] text-white/35 leading-relaxed pt-1">
            {verdict === "suspended"
              ? "لإعادة التفعيل تواصل مع إدارة النظام"
              : verdict === "unlicensed"
                ? "لتفعيل المتجر تواصل مع الدعم الفني"
                : "لتجديد الاشتراك تواصل مع الدعم الفني"}
            <br />
            النسخة 1.0.0 — © {new Date().getFullYear()} NexusCore
          </p>
        </div>
      </div>
    </div>
  );
}
