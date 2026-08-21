import { add, subtract, multiply, divide } from "@/lib/math";
import type { Transaction, Product, Partner } from "@/types";
import {
  calculateDistribution,
  calculateCOGS,
  type CostOfGoodsSold,
  type ProfitDistribution,
} from "./financeService";

export interface SaleItem {
  productId: string;
  quantity: number;
}

export interface ProcessSaleResult {
  success: boolean;
  transactionId?: string;
  error?: string;
  profitDistribution?: ProfitDistribution;
  updatedProducts?: Array<{ productId: string; quantityToDeduct: number }>;
}

/**
 * Transaction Engine for processing sales
 * Handles stock validation, updates, financial recording, and partnership profit distribution
 *
 * Note: This service performs validation and calculations. The actual state updates
 * should be performed by the caller using the returned information.
 */
export function processSale(
  items: SaleItem[],
  totalAmount: number,
  products: Product[],
  partners: Partner[],
  partnershipEnabled: boolean,
): ProcessSaleResult {
  // TODO: Analytics Engine integration point
  // Log sale initiation for analytics tracking

  // Validate items
  if (!items || items.length === 0) {
    return { success: false, error: "No items in sale" };
  }

  if (totalAmount <= 0) {
    return { success: false, error: "Invalid total amount" };
  }

  // Validate stock levels for each item and calculate quantity to deduct
  const updatedProducts: Array<{ productId: string; quantityToDeduct: number }> = [];

  for (const item of items) {
    const product = products.find((p) => p.id === item.productId);
    if (!product) {
      return { success: false, error: `Product ${item.productId} not found` };
    }

    if (product.quantity < item.quantity) {
      return {
        success: false,
        error: `Insufficient stock for ${product.name}. Available: ${product.quantity}, Requested: ${item.quantity}`,
      };
    }

    updatedProducts.push({
      productId: product.id,
      quantityToDeduct: item.quantity,
    });
  }

  // Create transaction record
  const transaction: Transaction = {
    id: crypto.randomUUID(),
    type: "sale",
    amount: totalAmount,
    timestamp: new Date(),
    category: "POS Sale",
    // TODO: Analytics Engine - add more metadata for tracking
  };

  // Calculate Cost of Goods Sold (COGS)
  // In production, this would fetch actual costs from inventory
  // For now, we'll use a simplified calculation (70% of revenue as cost)
  const costOfGoodsSold: CostOfGoodsSold = calculateCOGS(
    items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      unitCost: multiply(totalAmount, 0.7), // Simplified: 70% of revenue as cost
    })),
  );

  // Calculate profit distribution using finance service
  // This is agnostic of business mode - only cares about transaction total and costs
  const profitDistribution = calculateDistribution(
    transaction,
    costOfGoodsSold,
    partnershipEnabled ? partners.filter((p) => p.isActive) : [],
  );

  // TODO: Analytics Engine integration point
  // Log successful transaction with profit distribution details
  // Track sales patterns, popular products, etc.

  return {
    success: true,
    transactionId: transaction.id,
    profitDistribution,
    updatedProducts,
  };
}
