# Supabase Integration Setup Guide

This document explains how to set up the subscription automation and omnichannel integration system using Supabase.

## Overview

The system implements a self-serve subscription platform where:
- Users pay via payment gateway
- Webhook updates their subscription status in Supabase
- Real-time updates automatically unlock premium features in the UI
- Row Level Security (RLS) ensures only Pro users can access integration features

## Database Schema

### Tables

#### `profiles`
Stores user profile information including subscription status.
- `is_pro`: Boolean flag for Pro subscription
- `subscription_plan`: Plan type ('free', 'pro', 'enterprise')
- `subscription_expiry`: Subscription expiry date

#### `integrations`
Stores omnichannel integration configurations (Pro only).
- Protected by RLS policies
- Only accessible to users with `is_pro: true`

#### `online_orders`
Stores orders from external platforms.
- Linked to integrations table
- Tracks sync status and processing

#### `sync_logs`
Logs integration synchronization activities.
- Tracks success/failure statistics
- Monitors integration performance

## Setup Instructions

### 1. Environment Variables

Add these to your `.env` file:

```bash
VITE_SUPABASE_URL=your-supabase-url
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
```

### 2. Database Migrations

Run the migrations in order:

```bash
# Create database schema
supabase db push

# Apply RLS policies
supabase db push
```

### 3. Edge Function Deployment

Deploy the subscription webhook:

```bash
supabase functions deploy handle-subscription-webhook
```

Set the required environment variables for the Edge Function:

```bash
supabase secrets set SUPABASE_URL=your-supabase-url
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

### 4. Payment Gateway Integration

Configure your payment gateway (Stripe, PayPal, etc.) to send webhooks to:

```
https://your-project.supabase.co/functions/v1/handle-subscription-webhook
```

Webhook payload format:

```json
{
  "event": "subscription.activated",
  "data": {
    "user_id": "user-uuid",
    "plan_id": "pro",
    "expiry_date": "2024-12-31T23:59:59Z"
  }
}
```

Supported events:
- `subscription.created`
- `subscription.activated`
- `subscription.cancelled`
- `subscription.expired`
- `subscription.updated`

## Real-Time Updates

The system uses Supabase Realtime to automatically update the UI when subscription status changes:

1. User pays → Payment gateway sends webhook
2. Edge Function updates `profiles.is_pro` in database
3. Supabase Realtime pushes update to connected clients
4. UI automatically unlocks premium features without refresh

### Usage in Components

```typescript
import { useSubscriptionStore } from '@/store/useSubscriptionStore';

function MyComponent() {
  const { isProPlan, fetchSubscriptionStatus, subscribeToRealtimeUpdates } = useSubscriptionStore();
  const userId = 'user-uuid';

  // Fetch initial status
  useEffect(() => {
    fetchSubscriptionStatus(userId);
    
    // Subscribe to real-time updates
    const unsubscribe = subscribeToRealtimeUpdates(userId);
    
    return () => unsubscribe();
  }, [userId]);

  // Component automatically re-renders when status changes
  if (isProPlan) {
    return <PremiumFeature />;
  }
  return <FreeFeature />;
}
```

## Security

### Row Level Security (RLS)

The `integrations` table is protected by RLS policies:

- **SELECT**: Only Pro users can view their own integrations
- **INSERT**: Only Pro users can create integrations
- **UPDATE**: Only Pro users can update their own integrations
- **DELETE**: Only Pro users can delete their own integrations

Users cannot manually change their `is_pro` status - this is protected by RLS policies that only allow the service role to modify subscription status.

### API Key Encryption

Integration API keys are stored encrypted in the database using PostgreSQL's `ENCRYPTED` column type.

## Testing

### Manual Testing

Use the Settings page to simulate Pro Plan activation for testing:

1. Go to `/settings`
2. Toggle "الخطة الاحترافية (Pro Plan)"
3. Observe automatic UI updates

### Webhook Testing

Test the Edge Function locally:

```bash
supabase functions serve handle-subscription-webhook
```

Send a test webhook:

```bash
curl -X POST http://localhost:54321/functions/v1/handle-subscription-webhook \
  -H "Content-Type: application/json" \
  -d '{
    "event": "subscription.activated",
    "data": {
      "user_id": "test-user-id",
      "plan_id": "pro",
      "expiry_date": "2024-12-31T23:59:59Z"
    }
  }'
```

## Production Checklist

- [ ] Set up payment gateway (Stripe/PayPal)
- [ ] Configure webhook endpoints
- [ ] Deploy Edge Functions
- [ ] Apply database migrations
- [ ] Set environment variables
- [ ] Test webhook delivery
- [ ] Test real-time updates
- [ ] Verify RLS policies
- [ ] Monitor sync logs
- [ ] Set up error alerting

## Troubleshooting

### Real-time updates not working

1. Check that Realtime is enabled for the `profiles` table
2. Verify the user is subscribed to the correct channel
3. Check browser console for connection errors

### RLS blocking access

1. Verify user has `is_pro: true` in profiles table
2. Check RLS policies are applied correctly
3. Ensure user is authenticated

### Edge Function errors

1. Check Edge Function logs in Supabase dashboard
2. Verify environment variables are set
3. Test webhook payload format

## Analytics Engine Integration

The system includes TODO comments for Analytics Engine integration at:
- Subscription status changes
- Integration sync operations
- Order processing
- Feature access patterns

These integration points allow for comprehensive usage analytics and business intelligence.
