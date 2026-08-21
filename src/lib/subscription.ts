import { useSubscriptionStore } from "@/store/useSubscriptionStore";

/**
 * Premium feature access control utility
 * Checks if user has access to specific premium features based on subscription plan
 */

export type PremiumFeature =
  | "omnichannel_integration"
  | "advanced_analytics"
  | "multi_location"
  | "api_access"
  | "custom_reports";

/**
 * Check if user has access to a specific premium feature
 * @param featureName - The feature to check access for
 * @returns boolean indicating if access is granted
 */
export function checkPremiumAccess(featureName: PremiumFeature): boolean {
  const { isProPlan, subscriptionExpiry } = useSubscriptionStore.getState();

  // Check if subscription is active
  if (!isProPlan) {
    return false;
  }

  // Check if subscription has expired
  if (subscriptionExpiry && new Date() > subscriptionExpiry) {
    return false;
  }

  // TODO: Analytics Engine integration point
  // Log feature access attempts for usage analytics

  return true;
}

/**
 * Get subscription status for UI display
 * @returns Object with subscription status information
 */
export function getSubscriptionStatus() {
  const { isProPlan, subscriptionExpiry } = useSubscriptionStore.getState();

  if (!isProPlan) {
    return {
      isActive: false,
      plan: "Free",
      expiryDate: null,
      daysRemaining: 0,
    };
  }

  if (subscriptionExpiry) {
    const now = new Date();
    const daysRemaining = Math.ceil(
      (subscriptionExpiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
    );

    return {
      isActive: daysRemaining > 0,
      plan: "Pro",
      expiryDate: subscriptionExpiry,
      daysRemaining: Math.max(0, daysRemaining),
    };
  }

  return {
    isActive: true,
    plan: "Pro",
    expiryDate: null,
    daysRemaining: Infinity,
  };
}
