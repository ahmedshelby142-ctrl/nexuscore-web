import { checkPremiumAccess } from "@/lib/subscription";
import { processSale, type SaleItem } from "./transactionService";
import type { OnlineOrder, IntegrationAdapter, Product } from "@/types";

/**
 * Omnichannel Integration Service
 * Handles synchronization of orders from external platforms using Adapter Pattern
 * This service is gated by premium subscription access
 */

export interface SyncResult {
  success: boolean;
  processedOrders: number;
  failedOrders: number;
  errors: Array<{ orderId: string; error: string }>;
  message: string;
}

/**
 * Mock Adapter for testing purposes
 * In production, this would be replaced with actual API calls to platforms like Shopify, WooCommerce, etc.
 */
class MockAdapter implements IntegrationAdapter {
  source: string;

  constructor(source: string) {
    this.source = source;
  }

  async fetchPendingOrders(): Promise<OnlineOrder[]> {
    // TODO: Analytics Engine integration point
    // Log fetch attempts for integration analytics

    // Mock data - in production this would fetch from actual API
    return [
      {
        id: crypto.randomUUID(),
        orderId: "SHOP-001",
        customerData: {
          name: "أحمد محمد",
          email: "ahmed@example.com",
          phone: "+201234567890",
        },
        items: [
          {
            productId: "prod-1",
            productName: "منتج تجريبي 1",
            quantity: 2,
            unitPrice: 150,
          },
        ],
        totalAmount: 300,
        orderDate: new Date(),
        status: "pending",
        source: "shopify",
      },
    ];
  }

  async markOrderAsProcessed(orderId: string): Promise<void> {
    // TODO: Analytics Engine integration point
    // Log order processing completion
  }
}

/**
 * Adapter Registry for managing multiple integration sources
 * Allows easy addition of new platforms without modifying core logic
 */
class AdapterRegistry {
  private adapters: Map<string, IntegrationAdapter> = new Map();

  register(adapter: IntegrationAdapter): void {
    this.adapters.set(adapter.source, adapter);
  }

  getAdapter(source: string): IntegrationAdapter | undefined {
    return this.adapters.get(source);
  }

  getAllAdapters(): IntegrationAdapter[] {
    return Array.from(this.adapters.values());
  }
}

// Global adapter registry instance
const adapterRegistry = new AdapterRegistry();

// Register mock adapter for testing
adapterRegistry.register(new MockAdapter("shopify"));
adapterRegistry.register(new MockAdapter("woocommerce"));
adapterRegistry.register(new MockAdapter("custom"));

/**
 * Synchronize pending orders from all registered integration sources
 * This function is gated by premium subscription access
 *
 * @param products - Current product inventory for validation
 * @returns SyncResult with processing statistics
 */
export async function syncPendingOrders(products: Product[]): Promise<SyncResult> {
  // Premium access guard
  if (!checkPremiumAccess("omnichannel_integration")) {
    return {
      success: false,
      processedOrders: 0,
      failedOrders: 0,
      errors: [],
      message: "Pro Subscription Required: Omnichannel integration is a premium feature",
    };
  }

  // TODO: Analytics Engine integration point
  // Log sync initiation for integration analytics

  const adapters = adapterRegistry.getAllAdapters();
  let processedOrders = 0;
  let failedOrders = 0;
  const errors: Array<{ orderId: string; error: string }> = [];

  for (const adapter of adapters) {
    try {
      const pendingOrders = await adapter.fetchPendingOrders();

      for (const order of pendingOrders) {
        try {
          // Convert online order items to sale items
          const saleItems: SaleItem[] = order.items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
          }));

          // Process the sale through transaction engine
          const result = processSale(
            saleItems,
            order.totalAmount,
            products,
            [], // Partners - not needed for external orders
            false, // Partnership not applicable for external orders
          );

          if (result.success) {
            // Mark order as processed in external system
            await adapter.markOrderAsProcessed(order.orderId);
            processedOrders++;
          } else {
            failedOrders++;
            errors.push({
              orderId: order.orderId,
              error: result.error || "Unknown error",
            });
          }
        } catch (error) {
          failedOrders++;
          errors.push({
            orderId: order.orderId,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }
    } catch (error) {
      // Log adapter-level errors but continue with other adapters
      console.error(`Error processing adapter ${adapter.source}:`, error);
    }
  }

  // TODO: Analytics Engine integration point
  // Log sync completion with statistics
  // Track integration performance metrics

  return {
    success: failedOrders === 0,
    processedOrders,
    failedOrders,
    errors,
    message: `Sync completed: ${processedOrders} orders processed, ${failedOrders} failed`,
  };
}

/**
 * Register a new integration adapter
 * Use this to add support for new e-commerce platforms
 *
 * @param adapter - The integration adapter to register
 */
export function registerIntegrationAdapter(adapter: IntegrationAdapter): void {
  adapterRegistry.register(adapter);
}

/**
 * Get all registered integration sources
 *
 * @returns Array of registered adapter sources
 */
export function getRegisteredSources(): string[] {
  return adapterRegistry.getAllAdapters().map((adapter) => adapter.source);
}
