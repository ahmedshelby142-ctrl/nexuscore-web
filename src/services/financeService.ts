import { subtract, multiply, divide } from "@/lib/math";
import type { Transaction, Partner } from "@/types";

export interface CostOfGoodsSold {
  totalCost: number;
  items: Array<{
    productId: string;
    quantity: number;
    unitCost: number;
    totalCost: number;
  }>;
}

export interface ProfitDistribution {
  transactionId: string;
  totalRevenue: number;
  totalCost: number;
  netProfit: number;
  partnerDistributions: Array<{
    partnerId: string;
    partnerName: string;
    equityPercentage: number;
    shareAmount: number;
  }>;
  timestamp: Date;
}

/**
 * Profit Distribution Engine
 * Calculates and distributes profit across partners based on equity percentages
 * Works agnostic of business mode (Retail/Manufacturing/Wholesale)
 */

/**
 * Calculate profit distribution for a transaction
 * This function processes the financial math and distributes profit to partners
 *
 * @param transaction - The transaction to process
 * @param costOfGoodsSold - The COGS for the items in the transaction
 * @param partners - Array of active partners
 * @returns ProfitDistribution object with detailed breakdown
 */
export function calculateDistribution(
  transaction: Transaction,
  costOfGoodsSold: CostOfGoodsSold,
  partners: Partner[],
): ProfitDistribution {
  // TODO: Analytics Engine integration point
  // Log profit distribution calculation for financial analytics

  // Calculate Net Profit: Revenue - Cost
  const netProfit = subtract(transaction.amount, costOfGoodsSold.totalCost);

  // Validate that we have active partners
  const activePartners = partners.filter((p) => p.isActive);

  if (activePartners.length === 0) {
    // No active partners, profit goes to owner
    return {
      transactionId: transaction.id,
      totalRevenue: transaction.amount,
      totalCost: costOfGoodsSold.totalCost,
      netProfit,
      partnerDistributions: [],
      timestamp: transaction.timestamp,
    };
  }

  // Calculate total equity percentage
  const totalEquity = activePartners.reduce((sum, partner) => {
    return sum + partner.equityPercentage;
  }, 0);

  // Validate equity percentages sum to 100 (with tolerance for floating point)
  if (Math.abs(totalEquity - 100) > 0.01) {
    console.warn(
      `Total partner equity (${totalEquity}%) does not equal 100%. Proceeding with distribution.`,
    );
  }

  // Distribute profit to each partner based on equity percentage
  const partnerDistributions = activePartners.map((partner) => {
    const shareAmount = multiply(netProfit, divide(partner.equityPercentage, 100));
    return {
      partnerId: partner.id,
      partnerName: partner.name,
      equityPercentage: partner.equityPercentage,
      shareAmount,
    };
  });

  // TODO: Analytics Engine integration point
  // Track profit distribution patterns and partner performance

  return {
    transactionId: transaction.id,
    totalRevenue: transaction.amount,
    totalCost: costOfGoodsSold.totalCost,
    netProfit,
    partnerDistributions,
    timestamp: transaction.timestamp,
  };
}

/**
 * Calculate Cost of Goods Sold (COGS) for items
 * This is a simplified calculation - in production, this would fetch actual costs from inventory
 *
 * @param items - Array of items with costs
 * @returns CostOfGoodsSold object with detailed breakdown
 */
export function calculateCOGS(
  items: Array<{ productId: string; quantity: number; unitCost: number }>,
): CostOfGoodsSold {
  const itemsWithCost = items.map((item) => {
    const totalCost = multiply(item.quantity, item.unitCost);
    return {
      ...item,
      totalCost,
    };
  });

  const totalCost = itemsWithCost.reduce((sum, item) => sum + item.totalCost, 0);

  return {
    totalCost,
    items: itemsWithCost,
  };
}

/**
 * Get partner earnings summary for a specific partner
 *
 * @param partnerId - The partner's ID
 * @param ledger - Array of profit distribution records
 * @returns Total earnings and transaction count
 */
export function getPartnerEarnings(partnerId: string, ledger: ProfitDistribution[]) {
  const partnerDistributions = ledger.flatMap((record) =>
    record.partnerDistributions.filter((dist) => dist.partnerId === partnerId),
  );

  const totalEarnings = partnerDistributions.reduce((sum, dist) => sum + dist.shareAmount, 0);
  const transactionCount = partnerDistributions.length;

  return {
    totalEarnings,
    transactionCount,
    averagePerTransaction: transactionCount > 0 ? divide(totalEarnings, transactionCount) : 0,
  };
}
