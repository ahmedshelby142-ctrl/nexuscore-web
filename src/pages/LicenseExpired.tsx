import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useStoreLicense } from "@/store/useStoreLicense";
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
  const { decision, row, refresh, checking } = useStoreLicense();
  const logout = useAuthStore((s) => s.logout);
  const [retried, setRetried] = useState(false);

  const unverified = decision?.verdict === "unverified";
  /**
   * A shop that has NEVER been licensed is not a shop whose licence expired.
   *
   * `LicenseVerdict` has carried `unlicensed` separately from `expired` all
   * along; this screen collapsed the two and told every brand-new signup
   * "انتهت صلاحية الترخيص". That is false, and it is the specific falsehood
   * this file's own header warns about — an owner told their licence expired
   * reasonably reaches for a reinstall or a backup restore to "get their data
   * back", when in fact nothing was ever lost and nothing has run out.
   *
   * No policy is invented here: whether a new shop gets a trial or waits for
   * manual activation is a business decision this screen does not make. It
   * only stops claiming an expiry that never happened.
   */
  const unlicensed = decision?.verdict === "unlicensed";

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
                unverified || unlicensed ? "bg-amber-500/10" : "bg-red-500/10"
              }`}
            >
              <svg
                className={`size-8 ${unverified || unlicensed ? "text-amber-400" : "text-red-400"}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.6}
              >
                {unverified ? (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 9v3.75m0 3.75h.007M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                ) : (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75A2.25 2.25 0 004.5 12.75v6.75A2.25 2.25 0 006.75 21z"
                  />
                )}
              </svg>
            </div>

            <div className="space-y-2">
              <h2 className="text-2xl font-bold text-white">
                {unverified
                  ? "تعذّر التحقق من الترخيص"
                  : unlicensed
                    ? "المتجر لسه متفعّلش"
                    : "انتهت صلاحية الترخيص"}
              </h2>
              <p className="text-sm text-white/60 leading-relaxed">
                {unlicensed
                  ? "الحساب والمتجر اتعملوا بنجاح، وبياناتك كلها في مكانها. لسه محتاج تفعيل الاشتراك عشان تقدر تستخدم الشاشات — كلّم الدعم وهيتفعّل."
                  : (decision?.messageAr ?? "ترخيص هذا المتجر غير ساري حالياً.")}
              </p>
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
                <dt className="text-white/40 mb-1">تاريخ الانتهاء</dt>
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

            {retried && !checking && (
              <p className="text-center text-[12px] text-white/40">
                {unlicensed
                  ? "لسه مفيش تفعيل للمتجر ده. تواصل مع الدعم لتفعيل الاشتراك."
                  : "ما زال الترخيص غير ساري. تواصل مع الدعم لتجديد الاشتراك."}
              </p>
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
            لتجديد الاشتراك تواصل مع الدعم الفني
            <br />
            النسخة 1.0.0 — © {new Date().getFullYear()} NexusCore
          </p>
        </div>
      </div>
    </div>
  );
}
