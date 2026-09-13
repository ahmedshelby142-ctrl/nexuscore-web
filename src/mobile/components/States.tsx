import { AlertCircle, RotateCw, WifiOff } from "lucide-react";

export function EmptyState({ titleAr, messageAr }: { titleAr?: string; messageAr: string }) {
  return (
    <div className="mobile-state mobile-empty-state">
      {titleAr && <h3>{titleAr}</h3>}
      <p>{messageAr}</p>
    </div>
  );
}

export function ErrorState({ messageAr, onRetry }: { messageAr: string; onRetry?: () => void }) {
  return (
    <div className="mobile-state mobile-error-state">
      <AlertCircle className="mobile-state-icon" aria-hidden="true" />
      <p>{messageAr}</p>
      {onRetry && (
        <button type="button" className="mobile-primary-button" onClick={onRetry}>
          <RotateCw aria-hidden="true" size={16} />
          إعادة المحاولة
        </button>
      )}
    </div>
  );
}

export function OfflineState() {
  return (
    <div className="mobile-state mobile-offline-state">
      <WifiOff className="mobile-state-icon" aria-hidden="true" />
      <h3>لا يوجد اتصال بالإنترنت</h3>
      <p>يرجى التحقق من اتصالك بالإنترنت والمحاولة مرة أخرى.</p>
    </div>
  );
}

export function SkeletonState({ count = 3 }: { count?: number }) {
  return (
    <div className="mobile-skeleton-list">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="mobile-skeleton-row" />
      ))}
    </div>
  );
}
