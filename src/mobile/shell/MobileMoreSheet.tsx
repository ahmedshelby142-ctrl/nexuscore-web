import { ChevronLeft, LogOut, UserRound, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { ROLE_LABELS, toAppRole } from "@/lib/roles";
import { signOutCurrentSession } from "@/lib/auth/sessionWorkflow";
import { useAuthStore } from "@/store/useAuthStore";
import { getMobileCapabilities } from "@/mobile/navigation/mobileCapabilities";
import { getMoreModulesForRole } from "@/mobile/navigation/mobileNavigation";

export function MobileMoreSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const { username, userRole } = useAuthStore();
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose, open]);

  if (!open) return null;

  const role = toAppRole(userRole);
  const activeCapabilities = getMobileCapabilities(role);
  const moreModules = getMoreModulesForRole(role, activeCapabilities);

  const signOut = async () => {
    await signOutCurrentSession();
    onClose();
    navigate("/login", { replace: true });
  };

  return (
    <div className="mobile-sheet-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="mobile-more-sheet"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-more-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="mobile-sheet-handle" />
        <div className="mobile-sheet-title-row">
          <h2 id="mobile-more-title">المزيد</h2>
          <button ref={closeButtonRef} type="button" className="mobile-icon-button" onClick={onClose} aria-label="إغلاق">
            <X aria-hidden="true" />
          </button>
        </div>
        
        <div className="mobile-account-card">
          <UserRound aria-hidden="true" />
          <div>
            <p dir="ltr">{username || "—"}</p>
            <span>{ROLE_LABELS[role]}</span>
          </div>
        </div>

        <div className="mobile-more-modules">
          {moreModules.map((mod) => {
            const Icon = mod.icon;
            const isClickable = mod.isImplemented;

            return (
              <button
                key={mod.id}
                type="button"
                disabled={!isClickable}
                onClick={() => {
                  if (isClickable) {
                    navigate(mod.path ?? "/");
                    onClose();
                  }
                }}
                className="mobile-more-row"
              >
                <div className="mobile-more-row-main">
                  <Icon size={20} />
                  <span>{mod.label}</span>
                </div>
                {!isClickable && (
                  <span className="mobile-deferred-label">قريباً</span>
                )}
                {isClickable && <ChevronLeft aria-hidden="true" size={18} />}
              </button>
            );
          })}
        </div>

        <button type="button" className="mobile-signout-button" onClick={() => void signOut()}>
          <LogOut aria-hidden="true" />
          تسجيل الخروج
        </button>
      </section>
    </div>
  );
}
