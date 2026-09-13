/**
 * Mobile View Models — public API
 *
 * Re-exports everything the mobile screens need from the view model layer.
 * Import from here, not from individual files.
 */

export type {
  MobileMetric,
  MobileAlert,
  AlertLevel,
  MobileQueueItem,
  MobileOrderRow,
  MobileStockRow,
  MobileShipmentRow,
  MobileCustomerRow,
  StatusTone,
  StockStatusKey,
} from "./types";

export {
  ORDER_STATUS_TAXONOMY,
  SHIPMENT_STATUS_TAXONOMY,
  STOCK_STATUS_TAXONOMY,
  ALERT_LEVEL_TAXONOMY,
  resolveOrderStatus,
  resolveShipmentStatus,
  resolveStockStatus,
  resolveAlertLevel,
} from "./statusTaxonomies";

export {
  MOBILE_METRIC_DEFINITIONS,
  metricsForCapabilities,
  getMetricDefinition,
} from "./metricDefinitions";

export type { MetricDefinition } from "./metricDefinitions";

export {
  deriveAlerts,
  AGING_ORDER_THRESHOLD_HOURS,
  LONG_TRANSIT_THRESHOLD_HOURS,
} from "./alertModel";

export type { AlertModelInput } from "./alertModel";

export {
  toMobileOrderRow,
  toMobileOrderQueue,
  pendingOrderRows,
  shippedOrderRows,
} from "./orderViewModel";

export {
  toMobileStockRow,
  toMobileStockQueue,
  lowStockRows,
  deriveStockStatusKey,
} from "./stockViewModel";

export {
  toMobileShipmentRow,
  toMobileShipmentQueue,
} from "./shipmentViewModel";

export {
  toMobileCustomerRow,
  toMobileCustomerQueue,
  formatCustomerOrderCount,
} from "./customerViewModel";

export {
  formatArabicCurrency,
  formatArabicCount,
  formatArabicRelativeTime,
  formatArabicDate,
  formatArabicQuantity,
} from "./formatters";
