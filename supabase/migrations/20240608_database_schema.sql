-- Database Schema for Radiant Biz Panel
-- This file defines the core database structure for subscription management and omnichannel integration

-- ============================================
-- PROFILES TABLE
-- ============================================
-- Stores user profile information including subscription status
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  full_name TEXT,
  avatar_url TEXT,
  
  -- Subscription fields
  is_pro BOOLEAN DEFAULT false NOT NULL,
  subscription_plan TEXT, -- 'free', 'pro', 'enterprise'
  subscription_expiry TIMESTAMP WITH TIME ZONE,
  
  -- Metadata
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  
  CONSTRAINT valid_subscription_plan CHECK (subscription_plan IN ('free', 'pro', 'enterprise'))
);

-- Index for faster subscription lookups
CREATE INDEX IF NOT EXISTS idx_profiles_is_pro ON profiles(is_pro);
CREATE INDEX IF NOT EXISTS idx_profiles_subscription_expiry ON profiles(subscription_expiry);

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = timezone('utc'::text, now());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- INTEGRATIONS TABLE
-- ============================================
-- Stores omnichannel integration configurations
-- Access is restricted to Pro users via RLS policies
CREATE TABLE IF NOT EXISTS integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  
  -- Integration configuration
  source TEXT NOT NULL, -- 'shopify', 'woocommerce', 'custom', etc.
  source_id TEXT, -- External platform ID
  api_key TEXT ENCRYPTED, -- Encrypted API credentials
  api_secret TEXT ENCRYPTED, -- Encrypted API secrets
  webhook_url TEXT,
  
  -- Configuration JSON
  config JSONB DEFAULT '{}',
  
  -- Status
  is_active BOOLEAN DEFAULT true NOT NULL,
  last_sync_at TIMESTAMP WITH TIME ZONE,
  sync_status TEXT, -- 'success', 'error', 'pending'
  
  -- Metadata
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  
  CONSTRAINT valid_source CHECK (source IN ('shopify', 'woocommerce', 'custom', 'manual')),
  CONSTRAINT valid_sync_status CHECK (sync_status IN ('success', 'error', 'pending'))
);

-- Index for faster user integration lookups
CREATE INDEX IF NOT EXISTS idx_integrations_user_id ON integrations(user_id);
CREATE INDEX IF NOT EXISTS idx_integrations_source ON integrations(source);
CREATE INDEX IF NOT EXISTS idx_integrations_is_active ON integrations(is_active);

-- Trigger to update updated_at timestamp
CREATE TRIGGER update_integrations_updated_at
  BEFORE UPDATE ON integrations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- ONLINE ORDERS TABLE
-- ============================================
-- Stores orders from external platforms
CREATE TABLE IF NOT EXISTS online_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id UUID NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  
  -- Order details
  external_order_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_email TEXT,
  customer_phone TEXT,
  customer_address TEXT,
  
  -- Order items (JSONB array)
  items JSONB NOT NULL,
  total_amount DECIMAL(10, 2) NOT NULL,
  
  -- Order status
  status TEXT DEFAULT 'pending' NOT NULL,
  order_date TIMESTAMP WITH TIME ZONE NOT NULL,
  processed_at TIMESTAMP WITH TIME ZONE,
  
  -- Metadata
  source TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  
  CONSTRAINT valid_order_status CHECK (status IN ('pending', 'processing', 'completed', 'cancelled'))
);

-- Index for faster order lookups
CREATE INDEX IF NOT EXISTS idx_online_orders_integration_id ON online_orders(integration_id);
CREATE INDEX IF NOT EXISTS idx_online_orders_external_order_id ON online_orders(external_order_id);
CREATE INDEX IF NOT EXISTS idx_online_orders_status ON online_orders(status);
CREATE INDEX IF NOT EXISTS idx_online_orders_order_date ON online_orders(order_date);

-- Trigger to update updated_at timestamp
CREATE TRIGGER update_online_orders_updated_at
  BEFORE UPDATE ON online_orders
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- SYNC LOGS TABLE
-- ============================================
-- Logs integration synchronization activities
CREATE TABLE IF NOT EXISTS sync_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id UUID NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  
  -- Sync details
  sync_type TEXT NOT NULL, -- 'full', 'incremental', 'webhook'
  status TEXT NOT NULL, -- 'success', 'error', 'partial'
  
  -- Statistics
  orders_processed INTEGER DEFAULT 0,
  orders_failed INTEGER DEFAULT 0,
  items_synced INTEGER DEFAULT 0,
  
  -- Error details
  error_message TEXT,
  error_details JSONB,
  
  -- Metadata
  started_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  completed_at TIMESTAMP WITH TIME ZONE,
  duration_seconds INTEGER,
  
  CONSTRAINT valid_sync_type CHECK (sync_type IN ('full', 'incremental', 'webhook')),
  CONSTRAINT valid_sync_status CHECK (status IN ('success', 'error', 'partial'))
);

-- Index for faster sync log lookups
CREATE INDEX IF NOT EXISTS idx_sync_logs_integration_id ON sync_logs(integration_id);
CREATE INDEX IF NOT EXISTS idx_sync_logs_status ON sync_logs(status);
CREATE INDEX IF NOT EXISTS idx_sync_logs_started_at ON sync_logs(started_at);

-- ============================================
-- ENABLE REALTIME FOR SUBSCRIPTION UPDATES
-- ============================================
-- Enable realtime on profiles table for automatic UI updates
ALTER PUBLICATION supabase_realtime ADD TABLE profiles;

-- ============================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================
-- RLS policies are defined in separate migration file: 20240608_rls_policies.sql
-- This ensures proper security for subscription-gated features
