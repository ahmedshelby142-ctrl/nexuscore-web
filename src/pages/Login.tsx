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
} from "lucide-react";
import { useThemeStore } from "@/store/useThemeStore";
import logoLight from "@/assets/logo-light.png";
import logoDark from "@/assets/logo-dark.png";
import { useAuthStore } from "@/store/useAuthStore";
import { useBusinessStore } from "@/store/useBusinessStore";
import {
  BUSINESS_PROFILE_LABELS,
  BUSINESS_PROFILE_DESCRIPTIONS,
  BUSINESS_PROFILE_TO_BUSINESS_TYPE,
  BUSINESS_TYPE_TO_MODE,
  OPERATION_MODE_LABELS,
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
import { isDesktop, safeInvoke } from "../lib/tauri";

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
  const [opMode, setOpMode] = useState<OperationMode>("offline_local");
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [error, setLocalError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [machineId, setMachineId] = useState<string>("");

  // Compute the machine fingerprint once on mount.
  useEffect(() => {
    getMachineFingerprint().then(setMachineId);
  }, []);

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
        // [BYPASS] Developer bypass for default owner account (OFFLINE ONLY)
        if (opMode === "offline_local" && username.trim() === "owner" && password.trim() === "owner") {
          setSession({
            token: "dev-bypass-token",
            expires_at: new Date() as any,
            machine_id: "dev-machine",
            user: {
              id: "dev-owner-id",
              username: "owner",
              role: "owner",
              is_active: true,
              created_at: new Date() as any,
              must_change_password: false,
            }
          });
          setBusinessType(BUSINESS_PROFILE_TO_BUSINESS_TYPE[selectedProfile]);
          setOperationMode(opMode);
          setBusinessProfile(selectedProfile);
          setBusinessMode(BUSINESS_TYPE_TO_MODE[BUSINESS_PROFILE_TO_BUSINESS_TYPE[selectedProfile]]);
          navigate("/", { replace: true });
          return;
        }

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

        let userSession = null;
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

        setSession({
          token: userSession.access_token,
          expires_at: new Date(userSession.expires_at ? userSession.expires_at * 1000 : Date.now() + 3600000) as any,
          machine_id: "cloud-device",
          user: {
            id: userId,
            username: username.trim(),
            role: "owner",
            is_active: true,
            created_at: new Date() as any,
            must_change_password: false,
          }
        });

        // --- Tenancy Sync Resolution (LEDGER_SCHEMA §5) ---
        try {
          if (isDesktop) {
            const localIdentity: any = await safeInvoke("ledger_identity", {
              candidateStoreId: crypto.randomUUID(),
              candidateDeviceId: crypto.randomUUID(),
            });
            
            if (localIdentity && localIdentity.store_provisional) {
              const { data: claimData, error: claimError } = await sb.rpc("claim_store", {
                local_store_id: localIdentity.store_id,
              });

              if (!claimError && claimData) {
                const { canonical, rekey } = claimData as { canonical: string; rekey: boolean };
                
                if (rekey) {
                  await safeInvoke("ledger_retag_store", {
                    oldStoreId: localIdentity.store_id,
                    newStoreId: canonical,
                  });
                } else {
                  await safeInvoke("ledger_retag_store", {
                    oldStoreId: localIdentity.store_id,
                    newStoreId: localIdentity.store_id, 
                  });
                }
              } else {
                console.error("claim_store RPC failed:", claimError);
              }
            }
          }
        } catch (err) {
          console.error("Failed to resolve tenancy sync:", err);
        }
      }

      // Apply the business-profile preferences.
      setBusinessType(BUSINESS_PROFILE_TO_BUSINESS_TYPE[selectedProfile]);
      setOperationMode(opMode);
      setBusinessProfile(selectedProfile);
      setBusinessMode(BUSINESS_TYPE_TO_MODE[BUSINESS_PROFILE_TO_BUSINESS_TYPE[selectedProfile]]);

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
      <div className="absolute -top-40 -left-40 size-[500px] rounded-full bg-[#06B6D4]/10 blur-[120px]" />
      <div className="absolute -bottom-40 -right-40 size-[400px] rounded-full bg-[#06B6D4]/8 blur-[100px]" />
      <div className="absolute top-1/3 right-1/4 size-[200px] rounded-full bg-[#64748B]/10 blur-[80px]" />

      <div className="relative w-full max-w-[680px]">
        <div className="flex items-center justify-center gap-3 mb-8">
          <img src={logoSrc} alt="NexusCore" className="size-11 object-contain" />
          <div>
            <h1 className="text-3xl font-bold text-white font-display tracking-tight">NexusCore</h1>
            <p className="text-xs text-white/60 tracking-widest mt-0.5">
              نيكسوس كور — منظومة إدارة المؤسسات
            </p>
          </div>
        </div>

        <div className="rounded-3xl border border-[#1E293B] bg-[#1E293B]/80 backdrop-blur-2xl shadow-2xl shadow-[#06B6D4]/5 p-8 space-y-6">
          <div className="text-center">
            <h2 className="text-xl font-bold text-white">بوابة الدخول الذكية</h2>
            <p className="text-sm text-white/60 mt-1">
              {mustChangePassword
                ? "يرجى تغيير كلمة المرور المؤقتة للمتابعة"
                : "قم بتسجيل الدخول واختيار ملف النشاط التجاري"}
            </p>
          </div>

          <div className="h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />

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
                        className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/70 transition-colors"
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

              {/* Operation mode selector */}
              <div className="rounded-2xl border border-slate-700/40 bg-slate-800/30 p-4">
                <div className="space-y-1.5">
                  <Label className="text-slate-400 text-xs">نظام تشغيل البيانات</Label>
                  <Select value={opMode} onValueChange={(v: OperationMode) => setOpMode(v)}>
                    <SelectTrigger className="bg-slate-800/50 border-slate-700/60 text-white h-10 text-sm">
                      <SelectValue placeholder="اختر نظام التشغيل" />
                    </SelectTrigger>
                    <SelectContent>
                      {(["offline_local", "cloud_sync"] as const).map((m) => (
                        <SelectItem key={m} value={m}>
                          {OPERATION_MODE_LABELS[m]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
              
              <Button
                variant="destructive"
                type="button"
                onClick={async () => {
                  if (!confirm("هل أنت متأكد من مسح جميع البيانات المحلية؟ هذا الإجراء لا يمكن التراجع عنه.")) return;
                  try {
                    if (isDesktop) {
                      const Database = (await import("@tauri-apps/plugin-sql")).default;
                      const dbPath: string | null = await safeInvoke("ledger_db_path");
                      if (dbPath) {
                        const db = await Database.load(`sqlite:${dbPath}`);
                        const tables = [
                          "ledger_events",
                          "ledger_lines",
                          "products",
                          "customers",
                          "suppliers",
                          "discount_codes",
                          "return_records",
                          "app_state"
                        ];
                        for (const table of tables) {
                          await db.execute(`DELETE FROM ${table}`);
                        }
                        alert("تم مسح قاعدة البيانات المحلية بنجاح.");
                        window.location.reload();
                      }
                    } else {
                      alert("مسح قاعدة البيانات متاح فقط في نسخة سطح المكتب.");
                    }
                  } catch (e) {
                    console.error("Wipe failed:", e);
                    alert("حدث خطأ أثناء مسح قاعدة البيانات.");
                  }
                }}
                className="w-full h-11 text-base font-semibold bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30"
              >
                تصفير قاعدة البيانات المحلية
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
                  الوضع السحابي (Cloud Sync) يتطلب إنشاء حساب أو تسجيل الدخول بالبريد الإلكتروني للوصول إلى قاعدة بيانات Supabase. الوضع المحلي يبقي البيانات على الجهاز فقط.
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
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/70 transition-colors"
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
        </div>

        {machineId && !mustChangePassword && (
          <p className="text-center text-[10px] text-white/20 mt-4 font-mono" dir="ltr">
            machine-id: {machineId.slice(0, 12)}…
          </p>
        )}
        <p className="text-center text-xs text-white/30 mt-6">
          النسخة 1.0.0 — جميع الحقوق محفوظة © {new Date().getFullYear()} NexusCore
        </p>
      </div>
    </div>
  );
}
