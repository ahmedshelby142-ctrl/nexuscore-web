import { useEffect, useState } from "react";
import { Smartphone, LogOut } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { mobileAppUrl } from "@/lib/appSurfaces";
import { moveSessionToMobile } from "@/lib/auth/mobileSessionTransfer";
import { signOutCurrentSession } from "@/lib/auth/sessionWorkflow";

/**
 * MODERATOR on the Desktop origin — a defensive fallback, not a step.
 *
 * The normal MODERATOR paths never open the Desktop: invitations and password
 * resets target the Mobile app's `/set-password`, and the person signs in on
 * the Mobile app. This screen exists for the cases that still arrive here — a
 * Desktop URL typed by hand, an old Desktop tab refreshed — and it does one
 * thing: move the existing session to Mobile Home (`moveSessionToMobile`), so
 * nobody signs in twice and no Desktop screen is ever shown to the role.
 *
 * It renders no Desktop shell (it sits outside `<Layout>`), reads no business
 * data, and grants nothing: the Mobile app re-reads `store_members` on boot and
 * RLS answers every query.
 */
export function MobileAppRedirect() {
  const navigate = useNavigate();
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    void moveSessionToMobile("/").then((moved) => {
      if (!moved) setStuck(true);
    });
  }, []);

  return (
    <div className="min-h-screen grid place-items-center bg-background p-6" dir="rtl">
      <div className="w-full max-w-md space-y-5 rounded-2xl border border-border bg-card p-8 text-center">
        <Smartphone className="size-10 mx-auto text-primary" aria-hidden="true" />
        <h1 className="text-xl font-bold">افتح تطبيق العمليات على الموبايل</h1>
        {stuck ? (
          <>
            <p className="text-sm text-muted-foreground leading-relaxed">
              حسابك بيشتغل من تطبيق العمليات على الموبايل بس.
            </p>
            <Button asChild className="w-full">
              <a href={mobileAppUrl("/login")}>افتح تطبيق العمليات</a>
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={() =>
                void signOutCurrentSession().finally(() => navigate("/login", { replace: true }))
              }
            >
              <LogOut className="size-4 ml-2" aria-hidden="true" />
              تسجيل الخروج
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground" aria-live="polite">
            جارٍ فتح تطبيق العمليات…
          </p>
        )}
      </div>
    </div>
  );
}

export default MobileAppRedirect;
