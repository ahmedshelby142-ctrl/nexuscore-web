import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Eye,
  EyeOff,
  LogIn,
  Store,
  ShoppingBag,
  Globe,
  KeyRound,
  ShieldAlert,
  Info,
  RotateCcw,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { wipeLocalData } from "@/lib/localWipe";
import { useThemeStore } from "@/store/useThemeStore";
import logoLight from "@/assets/logo-light.png";
import logoDark from "@/assets/logo-dark.png";
import { useAuthStore } from "@/store/useAuthStore";
import { getOperationMode } from "@/lib/supabase";
import { clearStoreIdCache } from "@/services/api/storeContext";
import { toAppRole } from "@/lib/roles";
import { useBusinessStore } from "@/store/useBusinessStore";
import {
  BUSINESS_PROFILE_LABELS,
  BUSINESS_PROFILE_DESCRIPTIONS,
  BUSINESS_PROFILE_TO_BUSINESS_TYPE,
  BUSINESS_TYPE_TO_MODE,
  type BusinessProfile,
  type OperationMode,
} from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { login as serverLogin, changePassword as serverChangePassword } from "@/lib/api/authServer";
import { getMachineFingerprint } from "@/lib/machineId";
import { getSupabaseClient } from "@/lib/supabase";

const PROFILE_ICONS: Record<BusinessProfile, React.ElementType> = {
  omnichannel: Store,
  retail_only: ShoppingBag,
  ecommerce_only: Globe,
};

const PROFILES: BusinessProfile[] = ["omnichannel", "retail_only", "ecommerce_only"];

export function Login() {
  const navigate = useNavigate();
  const setSession = useAuthStore((s) => s.setSession);
  const setBusinessType = useAuthStore((s) => s.setBusinessType);
  const setOperationMode = useAuthStore((s) => s.setOperationMode);
  const setBusinessProfile = useAuthStore((s) => s.setBusinessProfile);
  const setStatus = useAuthStore((s) => s.setStatus);
  const setError = useAuthStore((s) => s.setError);
  const setBusinessMode = useBusinessStore((s) => s.setBusinessMode);
  const setBootstrapped = useAuthStore((s) => s.setBootstrapped);
  const session = useAuthStore((s) => s.session);
  const bootstrapped = useAuthStore((s) => s.bootstrapped);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const mode = useThemeStore((s) => s.mode);
  const logoSrc = mode === "dark" ? logoDark : logoLight;
  const [selectedProfile, setSelectedProfile] = useState<BusinessProfile>("omnichannel");
  // Not a choice any more. Whether this deployment talks to Supabase is
  // decided by whether Supabase is configured — there is no local database to
  // fall back to, so offering "local" as an option would offer an app with
  // nowhere to put anything.
  const opMode: OperationMode = getOperationMode();
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [error, setLocalError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [machineId, setMachineId] = useState<string>("");
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  // Compute the machine fingerprint once on mount.
  useEffect(() => {
    getMachineFingerprint().then(setMachineId);
  }, []);

  /**
   * Factory reset — the release build has no devtools, so this is the only way
   * to run the wipe on a compiled .exe.
   *
   * The confirm step is still not optional politeness, but the stakes changed:
   * nothing here is the only copy of anything any more, so this clears caches
   * and signs the user out rather than destroying sales. The dialog says so.
   */
  const openResetDialog = () => {
    setResetOpen(true);
  };

  const handleFactoryReset = async () => {
    setResetting(true);
    try {
      // `reload: false` matters: wipeLocalData reloads by default, which would
      // race the two clears below and leave them unfinished. The reload is done
      // last, deliberately, once everything is gone.
      await wipeLocalData({ force: true, reload: false });
    } catch (err) {
      // Even if clearing the caches fails, the
      // storage clears below still get the device out of its stuck state.
      console.error("factory reset: ledger wipe failed", err);
    }
    try {
      localStorage.clear();
      sessionStorage.clear();
    } finally {
      window.location.reload();
    }
  };

  const handleLogin = async () => {
    if (!username.trim() || !password.trim()) {
      setLocalError("يرجى إدخال الحساب وكلمة المرور");
      return;
    }
    if (!selectedProfile) {
      setLocalError("يرجى اختيار نوع النشاط التجاري");
      return;
    }

    setLocalError("");
    setIsSubmitting(true);
    setStatus("checking");

    try {
      if (opMode === "offline_local") {
        // The hardcoded `owner` / `owner` ADMIN bypass that used to sit here is
        // gone. It was gated on `offline_local`, which was ALSO the default
        // mode — and on a public URL that is not a developer convenience, it is
        // an unauthenticated admin login compiled into the bundle any visitor
        // can read. The real server login below is the only way in.
        const fp = machineId || (await getMachineFingerprint());
        const result = await serverLogin({
          data: {
            username: username.trim(),
            password: password.trim(),
            machine_id: fp,
          },
        });

        if (!result.success) {
          setLocalError(result.error ?? "تعذّر تسجيل الدخول");
          setError({
            code: "invalid_credentials",
            message: result.error ?? "تعذّر تسجيل الدخول",
          });
          return;
        }

        setSession(result.data);

        if (result.data.user.must_change_password) {
          setMustChangePassword(true);
          setStatus("online");
          return;
        }
      } else {
        // --- REAL CLOUD SUPABASE AUTH ---
        const sb = getSupabaseClient();
        if (!sb) {
          setLocalError("لم يتم العثور على إعدادات السحابة");
          return;
        }

        let userSession: any = null;
        let userId = "";

        if (authMode === "signup") {
          const { data, error } = await sb.auth.signUp({
            email: username.trim(),
            password: password.trim(),
          });
          if (error) {
            setLocalError(error.message);
            return;
          }
          userSession = data.session;
          userId = data.user?.id || "";
        } else {
          const { data, error } = await sb.auth.signInWithPassword({
            email: username.trim(),
            password: password.trim(),
          });
          if (error) {
            setLocalError(error.message);
            return;
          }
          userSession = data.session;
          userId = data.user?.id || "";
        }

        if (!userSession) {
          setLocalError("يرجى التحقق من بريدك الإلكتروني لتفعيل الحساب أو المحاولة مجدداً.");
          return;
        }

        // The role is the SERVER's answer, never a literal.
        //
        // This used to hardcode `role: "owner"`, so every cloud login — every
        // cashier, every accountant — arrived holding full admin in the client.
        // `store_members.role` is the same column the RLS policies read, so the
        // screen a user sees and the rows they may touch now come from one fact.
        //
        // A missing membership row means the account is not attached to this
        // shop yet; `toAppRole(null)` lands on the least privileged role rather
        // than assuming the best case.
        let { data: membership } = await sb
          .from("store_members")
          .select("role")
          .eq("user_id", userId)
          .maybeSingle();

        // No membership means this account belongs to no shop yet — which is
        // where EVERY new signup landed: authenticated, but with no store, no
        // licence and every write refused. It could not fix itself from the
        // client either: `stores` has no INSERT policy, and `store_members`
        // writes require has_role(store_id,'ADMIN') — the very row being
        // created. `claim_store` is the SECURITY DEFINER routine that exists to
        // break that deadlock; nothing had called it since the desktop build
        // was removed, and it inserted role 'owner', which its own CHECK
        // constraint rejects. Both are fixed (migration 014).
        //
        // Idempotent: an existing member gets their current store back, so a
        // retry or a second tab can never mint a second shop.
        if (!membership) {
          const { data: claimed, error: claimError } = await sb.rpc("claim_store", {
            local_store_id: crypto.randomUUID(),
          });
          if (claimError) {
            setLocalError(
              `تم تسجيل الدخول، لكن تعذّر ربط الحساب بمتجر. ${claimError.message}`,
            );
            return;
          }
          if (claimed) {
            const re = await sb
              .from("store_members")
              .select("role")
              .eq("user_id", userId)
              .maybeSingle();
            membership = re.data;
          }
        }

        setSession({
          token: userSession.access_token,
          expires_at: new Date(userSession.expires_at ? userSession.expires_at * 1000 : Date.now() + 3600000) as any,
          machine_id: "cloud-device",
          user: {
            id: userId,
            username: username.trim(),
            role: toAppRole(membership?.role),
            is_active: true,
            created_at: new Date() as any,
            must_change_password: false,
          }
        });

        // --- Tenancy ---
        // There is nothing to claim or re-tag: this browser has no local store
        // id of its own, and `store_members` is the only answer to "which store
        // is this?". Dropping the cache is all that login has to do.
        try {
          clearStoreIdCache();
          // The store is known now, so reference data can be read. Not awaited:
          // the dashboard renders and fills in as the tables land.
          void import("@/services/cloudHydrate")
            .then((m) => m.hydrateAll())
            .catch((e) => console.error("hydrate after login failed:", e));
        } catch (err) {
          console.error("Failed to resolve tenancy:", err);
        }
      }

      // Apply the business-profile preferences.
      setBusinessType(BUSINESS_PROFILE_TO_BUSINESS_TYPE[selectedProfile]);
      setOperationMode(opMode);
      setBusinessProfile(selectedProfile);
      setBusinessMode(BUSINESS_TYPE_TO_MODE[BUSINESS_PROFILE_TO_BUSINESS_TYPE[selectedProfile]]);

      // Read the cloud so this device starts the session as a mirror of the
      // server. Nothing is pushed first — there is no local queue that could be
      // holding work. Deliberately not awaited: a slow read must not hold the
      // user on the login screen.
      void import("@/services/cloudHydrate")
        .then((m) => m.hydrateAll())
        .catch((e) => console.error("[Login] hydrate failed:", e));

      navigate("/", { replace: true });
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "خطأ غير متوقع");
      setError({ code: "unknown", message: String(e) });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleChangePassword = async () => {
    if (newPassword.length < 8) {
      setLocalError("كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل");
      return;
    }
    if (!session) return;
    setIsSubmitting(true);
    try {
      const fp = machineId || (await getMachineFingerprint());
      const result = await serverChangePassword({
        data: {
          token: session.token,
          current_password: password, // the password they just logged in with
          new_password: newPassword,
        },
      });
      if (!result.success) {
        setLocalError(result.error ?? "تعذّر تغيير كلمة المرور");
        return;
      }
      // Re-set the session so the user can continue.
      setLocalError("");
      setMustChangePassword(false);
      setNewPassword("");

      // Apply business profile preferences.
      setBusinessType(BUSINESS_PROFILE_TO_BUSINESS_TYPE[selectedProfile]);
      setOperationMode(opMode);
      setBusinessProfile(selectedProfile);
      setBusinessMode(BUSINESS_TYPE_TO_MODE[BUSINESS_PROFILE_TO_BUSINESS_TYPE[selectedProfile]]);

      // Read the cloud so this device starts the session as a mirror of the
      // server. Nothing is pushed first — there is no local queue that could be
      // holding work. Deliberately not awaited: a slow read must not hold the
      // user on the login screen.
      void import("@/services/cloudHydrate")
        .then((m) => m.hydrateAll())
        .catch((e) => console.error("[Login] hydrate failed:", e));

      navigate("/", { replace: true });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      if (mustChangePassword) handleChangePassword();
      else handleLogin();
    }
  };

  return (
    <div
      className="relative min-h-screen flex items-center justify-center p-4 bg-[#0F172A] overflow-hidden"
      dir="rtl"
    >
      {/* Ambient light. Kept subtle: this screen is the first impression of a
          system people trust with their money, so it should read as calm and
          solid rather than decorated. */}
      <div className="absolute -top-40 -left-40 size-[520px] rounded-full bg-[#06B6D4]/12 blur-[130px]" />
      <div className="absolute -bottom-48 -right-32 size-[440px] rounded-full bg-[#0EA5E9]/10 blur-[110px]" />
      <div className="absolute top-1/3 right-1/4 size-[220px] rounded-full bg-[#64748B]/10 blur-[80px]" />
      <div
        className="absolute inset-0 opacity-[0.035]"
        style={{
          backgroundImage:
            "linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)",
          backgroundSize: "56px 56px",
        }}
      />

      <div className="relative w-full max-w-[1040px] grid lg:grid-cols-[0.85fr_1fr] gap-0 rounded-3xl overflow-hidden border border-[#1E293B] shadow-2xl shadow-black/40">
        {/* ── Brand panel. Hidden on small screens, where the form is all that
               matters and vertical space is scarce. ─────────────────────── */}
        <aside className="hidden lg:flex flex-col justify-between bg-gradient-to-br from-[#0B1220] via-[#0F172A] to-[#0B1220] border-l border-[#1E293B] p-10">
          <div className="flex items-center gap-3">
            <img src={logoSrc} alt="NexusCore" className="size-10 object-contain" />
            <div>
              <h1 className="text-2xl font-bold text-white font-display tracking-tight">
                NexusCore
              </h1>
              <p className="text-[11px] text-white/50 tracking-widest mt-0.5">
                منظومة إدارة المؤسسات
              </p>
            </div>
          </div>

          <div className="space-y-6">
            <h2 className="text-[26px] leading-snug font-bold text-white">
              كل رقم في المنظومة
              <br />
              <span className="text-[#06B6D4]">محسوب من دفتر الحسابات</span>
            </h2>
            <ul className="space-y-3.5">
              {[
                "مخزون وأرصدة محسوبة لحظياً من الدفتر",
                "بياناتك على السحابة، ومتاحة من أي جهاز",
                "صلاحيات مقفولة لكل دور على حدة",
              ].map((line) => (
                <li key={line} className="flex items-start gap-3 text-sm text-white/70">
                  <span className="mt-[6px] size-1.5 rounded-full bg-[#06B6D4] shrink-0 shadow-[0_0_8px_rgba(6,182,212,0.8)]" />
                  {line}
                </li>
              ))}
            </ul>
          </div>

          <p className="text-[11px] text-white/35 leading-relaxed">
            النسخة 1.0.0 — جميع الحقوق محفوظة © {new Date().getFullYear()} NexusCore
          </p>
        </aside>

        {/* ── Form panel ──────────────────────────────────────────────── */}
        <div className="bg-[#111C2E]/90 backdrop-blur-2xl p-8 sm:p-10 space-y-6 max-h-[92vh] overflow-y-auto">
          {/* The logo repeats here for small screens, where the panel above is
              hidden and the user would otherwise see an unbranded form. */}
          <div className="flex lg:hidden items-center justify-center gap-3 pb-2">
            <img src={logoSrc} alt="NexusCore" className="size-9 object-contain" />
            <h1 className="text-2xl font-bold text-white font-display">NexusCore</h1>
          </div>

          <div>
            <h2 className="text-2xl font-bold text-white tracking-tight">
              {mustChangePassword ? "تغيير كلمة المرور" : "تسجيل الدخول"}
            </h2>
            <p className="text-sm text-white/55 mt-1.5 leading-relaxed">
              {mustChangePassword
                ? "كلمة المرور الحالية مؤقتة — اختر واحدة جديدة للمتابعة."
                : "أدخل بياناتك واختر ملف النشاط التجاري للبدء."}
            </p>
          </div>

          <div className="h-px bg-gradient-to-l from-transparent via-white/15 to-transparent" />

          {!mustChangePassword ? (
            <>
              {/* Credentials */}
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label className="text-slate-300 text-sm">
                      {opMode === "cloud_sync" ? "البريد الإلكتروني" : "اسم المستخدم"}
                    </Label>
                    <Input
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder={opMode === "cloud_sync" ? "أدخل بريدك الإلكتروني" : "أدخل اسم المستخدم"}
                      autoComplete="username"
                      className="bg-slate-800/50 border-slate-700/60 text-white placeholder:text-slate-500 focus:border-[#06B6D4]/50 focus:ring-[#06B6D4]/20 h-11"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-slate-300 text-sm">كلمة المرور</Label>
                    <div className="relative">
                      <Input
                        type={showPassword ? "text" : "password"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="أدخل كلمة المرور"
                        autoComplete="current-password"
                        className="bg-slate-800/50 border-slate-700/60 text-white placeholder:text-slate-500 focus:border-[#06B6D4]/50 focus:ring-[#06B6D4]/20 h-11 pl-10"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        // Icon-only, so it announced as a bare "button" — on the
                        // first screen every user meets. `aria-pressed` carries
                        // the state, which the glyph alone cannot.
                        aria-label={showPassword ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}
                        aria-pressed={showPassword}
                        // `-m-2 p-2` grows the hit area to 32px without moving the glyph or
                        // changing its size: the icon was a 16×16 target, which is
                        // under the 24px minimum and hard to hit on a phone.
                        className="absolute left-3 top-1/2 -translate-y-1/2 -m-2 p-2 text-white/40 hover:text-white/70 transition-colors"
                      >
                        {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* 3 Business Profile Cards - Retail & E-commerce Only */}
              <div className="rounded-2xl border border-slate-700/40 bg-slate-800/30 p-5 space-y-4">
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest text-center">
                  اختر ملف النشاط التجاري
                </p>
                <div className="grid grid-cols-3 gap-3">
                  {PROFILES.map((p) => {
                    const Icon = PROFILE_ICONS[p];
                    const isSelected = selectedProfile === p;
                    return (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setSelectedProfile(p)}
                        className={cn(
                          "flex flex-col items-center gap-2 rounded-xl border p-4 text-center transition-all duration-200",
                          isSelected
                            ? "border-[#06B6D4]/60 bg-[#06B6D4]/10 shadow-lg shadow-[#06B6D4]/10"
                            : "border-slate-700/30 bg-slate-800/20 hover:bg-slate-700/30 hover:border-slate-600/50",
                        )}
                      >
                        <Icon
                          className={cn("size-6", isSelected ? "text-[#06B6D4]" : "text-slate-400")}
                        />
                        <span
                          className={cn(
                            "text-xs font-medium leading-tight",
                            isSelected ? "text-white" : "text-slate-300",
                          )}
                        >
                          {BUSINESS_PROFILE_LABELS[p]}
                        </span>
                        <span
                          className={cn(
                            "text-[10px] leading-relaxed line-clamp-2",
                            isSelected ? "text-[#06B6D4]/70" : "text-slate-500",
                          )}
                        >
                          {BUSINESS_PROFILE_DESCRIPTIONS[p]}
                        </span>
                        {isSelected && <span className="size-1.5 rounded-full bg-[#06B6D4]" />}
                      </button>
                    );
                  })}
                </div>
              </div>

              {error && (
                <div className="text-red-300 text-sm text-center bg-red-500/10 rounded-lg py-2 px-3 border border-red-500/20 flex items-center justify-center gap-2">
                  <ShieldAlert className="size-4" />
                  {error}
                </div>
              )}

              <Button
                onClick={handleLogin}
                disabled={isSubmitting}
                className="w-full h-11 text-base font-semibold bg-[#06B6D4] hover:bg-[#0891b2] text-white shadow-lg shadow-[#06B6D4]/25"
              >
                <LogIn className="size-4 ml-2" />
                {isSubmitting ? "يرجى الانتظار…" : (authMode === "signup" ? "إنشاء الحساب الجديد" : "دخول إلى النظام")}
              </Button>
              

              {opMode === "cloud_sync" && (
                <div className="text-center pt-2">
                  <button
                    type="button"
                    onClick={() => setAuthMode(authMode === "signin" ? "signup" : "signin")}
                    className="text-sm text-[#06B6D4] hover:text-[#0891b2] transition-colors"
                  >
                    {authMode === "signin" ? "لا تمتلك حساباً؟ إنشاء حساب جديد" : "لديك حساب بالفعل؟ تسجيل الدخول"}
                  </button>
                </div>
              )}

              <div className="rounded-lg bg-slate-800/40 border border-slate-700/40 p-3 flex items-start gap-2 text-[11px] text-slate-400 leading-relaxed">
                <Info className="size-3.5 shrink-0 mt-0.5 text-cyan-400" />
                <p>
                  يتطلب الدخول إنشاء حساب أو تسجيل الدخول بالبريد الإلكتروني. كل البيانات محفوظة على قاعدة بيانات Supabase، ولا يُحفظ أي شيء على هذا الجهاز.
                </p>
              </div>
            </>
          ) : (
            <>
              {/* Force-change-password flow */}
              <div className="space-y-3">
                <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-3 text-amber-200 text-xs flex items-start gap-2">
                  <KeyRound className="size-4 shrink-0 mt-0.5" />
                  <p>
                    هذه أول مرة تسجل فيها الدخول. يرجى اختيار كلمة مرور جديدة قوية (8 أحرف على
                    الأقل) قبل المتابعة.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-slate-300 text-sm">كلمة المرور الجديدة</Label>
                  <div className="relative">
                    <Input
                      type={showPassword ? "text" : "password"}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder="8 أحرف على الأقل"
                      autoComplete="new-password"
                      className="bg-slate-800/50 border-slate-700/60 text-white placeholder:text-slate-500 focus:border-[#06B6D4]/50 focus:ring-[#06B6D4]/20 h-11 pl-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      aria-label={showPassword ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}
                      aria-pressed={showPassword}
                      // `-m-2 p-2` grows the hit area to 32px without moving the glyph or
                        // changing its size: the icon was a 16×16 target, which is
                        // under the 24px minimum and hard to hit on a phone.
                        className="absolute left-3 top-1/2 -translate-y-1/2 -m-2 p-2 text-white/40 hover:text-white/70 transition-colors"
                    >
                      {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </div>
                </div>
                {error && (
                  <p className="text-red-300 text-sm bg-red-500/10 rounded-lg py-2 px-3 border border-red-500/20">
                    {error}
                  </p>
                )}
                <Button
                  onClick={handleChangePassword}
                  disabled={isSubmitting || newPassword.length < 8}
                  className="w-full h-11 text-base font-semibold bg-[#06B6D4] hover:bg-[#0891b2] text-white shadow-lg shadow-[#06B6D4]/25"
                >
                  <KeyRound className="size-4 ml-2" />
                  {isSubmitting ? "جاري التحديث…" : "تأكيد ودخول"}
                </Button>
              </div>
            </>
          )}

          {/* Inside the form panel, not after it: as a sibling of the grid
              columns it became a third cell and broke the two-panel layout.
              The copyright lives in the brand panel now — no duplicate. */}
          {/* ── Factory reset ────────────────────────────────────────────
              Lives on the login screen because the release build ships no
              devtools: this is the only way to clear a device that is stuck on
              a dead store id. Separated by a rule and styled as destructive so
              it never reads as part of the sign-in flow. */}
          {!mustChangePassword && (
            <div className="pt-4 mt-2 border-t border-white/10 space-y-2">
              <Button
                type="button"
                variant="ghost"
                onClick={openResetDialog}
                disabled={isSubmitting || resetting}
                className="w-full h-10 text-red-400/80 hover:text-red-300 hover:bg-red-500/10 border border-red-500/20"
              >
                <RotateCcw className="size-4 ml-2" />
                {resetting ? "جارٍ المسح…" : "ضبط المصنع"}
              </Button>
              <p className="text-center text-[10px] text-white/25 leading-relaxed">
                يمسح كل البيانات المحلية على هذا الجهاز ويعيد تحميلها من السحابة
              </p>
            </div>
          )}

          {machineId && !mustChangePassword && (
            <p className="text-center text-[10px] text-white/20 pt-2 font-mono" dir="ltr">
              machine-id: {machineId.slice(0, 12)}…
            </p>
          )}

          <AlertDialog open={resetOpen} onOpenChange={(o) => !resetting && setResetOpen(o)}>
            <AlertDialogContent dir="rtl">
              <AlertDialogHeader>
                <AlertDialogTitle>ضبط المصنع لهذا الجهاز؟</AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <div className="space-y-3 leading-relaxed">
                    <p>
                      سيتم مسح كل البيانات المحلية على هذا الجهاز: المنتجات
                      والعملاء والطلبات ودفتر الحسابات وبيانات الدخول. لا يمكن
                      التراجع عن هذا الإجراء.
                    </p>
                    <p>
                      البيانات الموجودة على السحابة{" "}
                      <span className="font-semibold text-foreground">لن تتأثر</span>، وسيتم
                      تحميلها من جديد بعد تسجيل الدخول.
                    </p>
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={resetting}>إلغاء</AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => {
                    // The dialog closes on click by default; the reset needs the
                    // component alive long enough to finish and reload.
                    e.preventDefault();
                    void handleFactoryReset();
                  }}
                  disabled={resetting}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {resetting ? "جارٍ المسح…" : "نعم، امسح كل شيء"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <p className="lg:hidden text-center text-xs text-white/30">
            النسخة 1.0.0 — © {new Date().getFullYear()} NexusCore
          </p>
        </div>
      </div>
    </div>
  );
}
