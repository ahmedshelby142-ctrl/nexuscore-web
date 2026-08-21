import { create } from "zustand";
import { persist } from "zustand/middleware";
import { getSupabaseClient, subscribeToProfileChanges, isSupabaseConfigured } from "@/lib/supabase";

/**
 * Subscription Store for managing premium features access
 * This store controls access to omnichannel integration and other premium features
 * Now integrated with Supabase for real-time subscription status updates (optional)
 */
interface SubscriptionState {
  isProPlan: boolean;
  subscriptionExpiry?: Date;
  userId?: string;
  isLoading: boolean;
  setProPlan: (enabled: boolean) => void;
  setSubscriptionExpiry: (date: Date) => void;
  setUserId: (userId: string) => void;
  fetchSubscriptionStatus: (userId: string) => Promise<void>;
  subscribeToRealtimeUpdates: (userId: string) => () => void;
}

export const useSubscriptionStore = create<SubscriptionState>()(
  persist(
    (set, get) => ({
      isProPlan: false,
      subscriptionExpiry: undefined,
      userId: undefined,
      isLoading: false,

      setProPlan: (enabled: boolean) => {
        set({ isProPlan: enabled });
        // TODO: Analytics Engine - track subscription changes
      },

      setSubscriptionExpiry: (date: Date) => {
        set({ subscriptionExpiry: date });
      },

      setUserId: (userId: string) => {
        set({ userId });
      },

      /**
       * Fetch subscription status from Supabase profiles table
       * This is called on app initialization to get the real subscription status
       * Only works if Supabase is configured, otherwise falls back to local storage
       */
      fetchSubscriptionStatus: async (userId: string) => {
        set({ isLoading: true });

        const supabase = getSupabaseClient();

        if (!supabase || !isSupabaseConfigured()) {
          set({ isLoading: false });
          return;
        }

        try {
          const { data, error } = await supabase
            .from("profiles")
            .select("is_pro, subscription_expiry")
            .eq("id", userId)
            .single();

          if (error) {
            console.error("Error fetching subscription status:", error);
            // Fall back to local storage if Supabase fails
            return;
          }

          if (data) {
            set({
              isProPlan: data.is_pro || false,
              subscriptionExpiry: data.subscription_expiry
                ? new Date(data.subscription_expiry)
                : undefined,
              userId,
            });
          }
        } catch (error) {
          console.error("Error fetching subscription status:", error);
          // Fall back to local storage if Supabase fails
        } finally {
          set({ isLoading: false });
        }
      },

      /**
       * Subscribe to real-time updates from Supabase
       * Automatically updates UI when subscription status changes in database
       * Returns unsubscribe function
       * Only works if Supabase is configured
       */
      subscribeToRealtimeUpdates: (userId: string) => {
        const channel = subscribeToProfileChanges(userId, (profile) => {
          set({
            isProPlan: profile.is_pro || false,
            subscriptionExpiry: profile.subscription_expiry
              ? new Date(profile.subscription_expiry)
              : undefined,
          });

          // TODO: Analytics Engine - track subscription status changes
        });

        // Return unsubscribe function if channel exists, otherwise return no-op
        if (channel) {
          return () => {
            const supabase = getSupabaseClient();
            if (supabase) {
              supabase.removeChannel(channel);
            }
          };
        }

        // Return no-op function if Supabase is not configured
        return () => {};
      },
    }),
    {
      name: "subscription-storage",
      // Only persist local fallback data, not the real-time Supabase data
      partialize: (state) => ({
        isProPlan: state.isProPlan,
        subscriptionExpiry: state.subscriptionExpiry,
      }),
    },
  ),
);
