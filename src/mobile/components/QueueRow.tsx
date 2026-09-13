import { Link } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import type { MobileQueueItem } from "@/mobile/viewmodels/types";
import { StatusPill } from "./StatusPill";

export interface QueueRowProps {
  item: MobileQueueItem;
}

export function QueueRow({ item }: QueueRowProps) {
  return (
    <Link to={item.href} className="mobile-queue-row">
      <div className="mobile-queue-row-main">
        <div className="mobile-queue-row-header">
          <span className="mobile-queue-row-title">{item.title}</span>
          <StatusPill labelAr={item.statusLabelAr} tone={item.statusTone} />
        </div>
        
        {item.subtitle && (
          <span className="mobile-queue-row-subtitle">{item.subtitle}</span>
        )}
        
        <div className="mobile-queue-row-footer">
          {item.ageAr && <span className="mobile-queue-row-age">{item.ageAr}</span>}
          <div className="mobile-queue-row-values">
            {item.secondaryValue && (
              <span className="mobile-queue-row-secondary">{item.secondaryValue}</span>
            )}
            {item.primaryValue && (
              <span className="mobile-queue-row-primary">{item.primaryValue}</span>
            )}
          </div>
        </div>
      </div>
      <div className="mobile-queue-row-chevron">
        <ChevronLeft aria-hidden="true" size={20} />
      </div>
    </Link>
  );
}
