import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { KeyRound, ShieldCheck } from "lucide-react";
import { getSupabaseClient } from "@/lib/supabase";
import { checkLeakedPassword, LEAKED_PASSWORD_MESSAGE_AR } from "@/lib/security";
import { toAppRole, homeFor, ROLE_LABELS } from "@/lib/roles";
import { useAuthStore } from "@/store/useAuthStore";
import { useRunOnce } from "@/hooks/useSubmitGate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Where an invitation link lands — the half of onboarding that was missing.
 *
 * `invite-staff` creates the account and the membership, and Supabase mails a
 * link. Until now nothing in this app answered that link. An invited employee
 * arrived at the root with `#access_token=…&type=invite` in the URL, supabase-js
 * quietly turned it into a session (`detectSessionInUrl` is on by default), and
 * they were signed in to an account **with no password** — so the moment that
 * session expired they were locked out for good, with no screen anywhere that
 * could set one.
 *
 * This screen closes that. It is deliberately small: read the session the link
 * established, set a password, go to the shop.
 *
 * ## What it must not do
 *
 * **It must never call `claim_store`.** That is what `/login` does for an
 * account with no membership, and it creates a brand new shop with the caller
 * as its ADMIN. Running it here would hand an invited employee their own empty
 * tenant — the precise failure the invitation flow exists to prevent. Someone
 * who reaches this screen without a membership is not an invited employee, so
 * they are sent to the login screen rather than given a store.
 *
 * The role is read from `store_members`, the same column RLS reads. Nothing
 * about permissions is decided here.
 */
export function SetPassword() {
  const navigate = useNavigate();
  const setSession = useAuthStore((s) => s.setSession);
  const runOnce = useRunOnce();

  /** null while we are still asking supabase-js whether the link carried one. */
  const [email, setEmail] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const sb = getSupabaseClient();
      if (!sb) {
        if (!cancelled) {
          setError("الإعداد ناقص: التطبيق مش موصول بالسحابة.");
          setChecking(false);
        }
        return;
      }
      // supabase-js has already consumed the URL fragment by the time this
      // runs; getSession() is how we find out whether it found anything.
      const { data } = await sb.auth.getSession();
      if (cancelled) return;
      setEmail(data.session?.user.email ?? null);
      setChecking(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async () =>
    runOnce(async () => {
      const sb = getSupabaseClient();
      if (!sb) return;

      if (password.length < 8) {
        setError("الباسورد لازم يكون 8 حروف على الأقل.");
        return;
      }
      if (password !== confirm) {
        setError("الباسوردين مش زي بعض.");
        return;
      }

      setError(null);
      setSaving(true);
      try {
        // Same guard as signup. It fails open on an outage, so it can never
        // lock someone out of finishing their own onboarding.
        if (await checkLeakedPassword(password)) {
          setError(LEAKED_PASSWORD_MESSAGE_AR);
          return;
        }

        const { data: updated, error: updateError } = await sb.auth.updateUser({ password });
        if (updateError || !updated?.user) {
          setError(
            updateError?.message
              ? `تعذّر حفظ الباسورد: ${updateError.message}`
              : "تعذّر حفظ الباسورد.",
          );
          return;
        }

        // Which shop, and which role — from the table, not from the link.
        const { data: membership } = await sb
          .from("store_members")
          .select("role")
          .eq("user_id", updated.user.id)
          .maybeSingle();

        if (!membership) {
          // Deliberately NOT claim_store. See the note at the top.
          setError(
            "الحساب اتعمل بس مش مربوط بأي محل. كلّم صاحب المحل يبعتلك دعوة تاني.",
          );
          return;
        }

        const { data: session } = await sb.auth.getSession();
        const role = toAppRole(membership.role);
        setSession({
          token: session.session?.access_token ?? "",
          expires_at: new Date(
            session.session?.expires_at
              ? session.session.expires_at * 1000
              : Date.now() + 3600000,
          ) as never,
          machine_id: "cloud-device",
          user: {
            id: updated.user.id,
            username: updated.user.email ?? "",
            role,
            is_active: true,
            created_at: new Date() as never,
          },
        } as never);

        navigate(homeFor(role), { replace: true });
      } finally {
        setSaving(false);
      }
    });

  if (checking) {
    return (
      <div className="min-h-screen grid place-items-center bg-background" dir="rtl">
        <p className="text-muted-foreground">جاري التحقق من الدعوة...</p>
      </div>
    );
  }

  // No session means the link was never opened, has already been used, or has
  // expired. Say which rather than showing a form that cannot work.
  if (!email) {
    return (
      <div className="min-h-screen grid place-items-center bg-background p-6" dir="rtl">
        <div className="max-w-md space-y-4 text-center rounded-2xl border border-border bg-card p-8">
          <ShieldCheck className="size-10 mx-auto text-muted-foreground/60" />
          <h1 className="text-xl font-bold">الدعوة مش صالحة</h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            الرابط ده لازم يتفتح من الإيميل اللي وصلك، ومرة واحدة بس. لو كنت حطيت
            باسورد قبل كده ادخل عادي من شاشة الدخول، ولو الرابط قديم اطلب دعوة جديدة
            من صاحب المحل.
          </p>
          <Button variant="outline" onClick={() => navigate("/login")}>
            روح لشاشة الدخول
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen grid place-items-center bg-background p-6" dir="rtl">
      <div className="w-full max-w-md space-y-6 rounded-2xl border border-border bg-card p-8">
        <div className="text-center space-y-2">
          <KeyRound className="size-10 mx-auto text-primary" />
          <h1 className="text-2xl font-bold">أهلاً بيك في NexusCore</h1>
          <p className="text-sm text-muted-foreground">
            حط باسورد لحسابك عشان تقدر تدخل بيه بعد كده.
          </p>
          <p className="text-sm font-medium" dir="ltr">
            {email}
          </p>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-password">الباسورد الجديد</Label>
            <Input
              id="new-password"
              type="password"
              dir="ltr"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm-password">أكّد الباسورد</Label>
            <Input
              id="confirm-password"
              type="password"
              dir="ltr"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
            />
          </div>

          {error && <p className="text-sm font-medium text-destructive">{error}</p>}

          <Button className="w-full" onClick={() => void submit()} disabled={saving}>
            {saving ? "جاري الحفظ..." : "احفظ وادخل"}
          </Button>
        </div>

        <p className="text-xs text-muted-foreground text-center leading-relaxed">
          صلاحيتك على المحل محدّدة من صاحب المحل — واحدة من:{" "}
          {Object.values(ROLE_LABELS).join("، ")}.
        </p>
      </div>
    </div>
  );
}

export default SetPassword;
