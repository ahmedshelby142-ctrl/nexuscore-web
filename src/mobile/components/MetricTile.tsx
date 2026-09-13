/**
 * MetricTile — a single KPI tile for the mobile home screen.
 *
 * Receives a `MobileMetric` (already computed by the data layer) and renders
 * it. No calculation happens here. No database calls.
 *
 * 44px+ tap target via the anchor wrapper.
 * RTL-ready: value on top, label below.
 */

import { Link } from "react-router-dom";
import type { MobileMetric } from "@/mobile/viewmodels/types";

export interface MetricTileProps {
  metric: MobileMetric;
  /** Set to true while the data is loading. Shows skeleton instead. */
  loading?: boolean;
  /** Set to true if the data load failed. Shows error indicator. */
  error?: boolean;
}

export function MetricTile({ metric, loading, error }: MetricTileProps) {
  const content = (
    <div className="mobile-metric-tile" aria-label={`${metric.labelAr}: ${metric.value}`}>
      <span className="mobile-metric-value" aria-hidden="true">
        {loading ? (
          <span className="mobile-skeleton-text" aria-hidden="true" />
        ) : error ? (
          <span className="mobile-metric-error">—</span>
        ) : (
          metric.value
        )}
      </span>
      {metric.unitAr && !loading && !error && (
        <span className="mobile-metric-unit"> {metric.unitAr}</span>
      )}
      <span className="mobile-metric-label">{metric.labelAr}</span>
    </div>
  );

  if (metric.href && !loading && !error) {
    return (
      <Link to={metric.href} className="mobile-metric-tile-link">
        {content}
      </Link>
    );
  }

  return content;
}
