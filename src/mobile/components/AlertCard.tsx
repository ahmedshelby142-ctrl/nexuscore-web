import { Link } from "react-router-dom";
import type { MobileAlert } from "@/mobile/viewmodels/types";
import { AlertCircle, AlertTriangle, Info, BellRing, ChevronLeft } from "lucide-react";

export interface AlertCardProps {
  alert: MobileAlert;
}

const ICON_MAP = {
  CRITICAL: AlertCircle,
  ACTION: BellRing,
  WARNING: AlertTriangle,
  INFO: Info,
};

export function AlertCard({ alert }: AlertCardProps) {
  const Icon = ICON_MAP[alert.level];
  const levelClass = alert.level.toLowerCase();

  return (
    <Link to={alert.href} className={`mobile-alert-card mobile-alert-${levelClass}`}>
      <div className="mobile-alert-icon">
        <Icon aria-hidden="true" />
      </div>
      <div className="mobile-alert-content">
        <div className="mobile-alert-header">
          <h3 className="mobile-alert-title">{alert.titleAr}</h3>
          {alert.count > 1 && <span className="mobile-alert-badge">{alert.count}</span>}
        </div>
        <p className="mobile-alert-message">{alert.messageAr}</p>
        <p className="mobile-alert-resolution">{alert.clearConditionAr}</p>
      </div>
      <div className="mobile-alert-chevron">
        <ChevronLeft aria-hidden="true" size={20} />
      </div>
    </Link>
  );
}
