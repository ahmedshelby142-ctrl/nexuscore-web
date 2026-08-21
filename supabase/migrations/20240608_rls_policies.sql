-- RLS Policy Strategy for Omnichannel Integration
-- This file defines Row Level Security policies for the integrations table
-- ensuring only Pro users can access integration features

-- Enable RLS on integrations table
ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;

-- Policy: Pro users can SELECT their own integration configurations
CREATE POLICY "Users can view own integrations if pro"
ON integrations FOR SELECT
USING (
  auth.uid() = user_id 
  AND EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.id = auth.uid() 
    AND profiles.is_pro = true
  )
);

-- Policy: Pro users can INSERT their own integration configurations
CREATE POLICY "Users can insert own integrations if pro"
ON integrations FOR INSERT
WITH CHECK (
  auth.uid() = user_id 
  AND EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.id = auth.uid() 
    AND profiles.is_pro = true
  )
);

-- Policy: Pro users can UPDATE their own integration configurations
CREATE POLICY "Users can update own integrations if pro"
ON integrations FOR UPDATE
USING (
  auth.uid() = user_id 
  AND EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.id = auth.uid() 
    AND profiles.is_pro = true
  )
);

-- Policy: Pro users can DELETE their own integration configurations
CREATE POLICY "Users can delete own integrations if pro"
ON integrations FOR DELETE
USING (
  auth.uid() = user_id 
  AND EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.id = auth.uid() 
    AND profiles.is_pro = true
  )
);

-- Additional security: Service role can bypass RLS for system operations
CREATE POLICY "Service role can manage all integrations"
ON integrations FOR ALL
USING (auth.role() = 'service_role');

-- Profiles table RLS policies for subscription status
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Users can always view their own profile
CREATE POLICY "Users can view own profile"
ON profiles FOR SELECT
USING (auth.uid() = id);

-- Users can update their own profile (limited fields)
CREATE POLICY "Users can update own profile"
ON profiles FOR UPDATE
USING (auth.uid() = id)
WITH CHECK (
  auth.uid() = id 
  AND -- Prevent users from manually changing is_pro status
  (OLD.is_pro = NEW.is_pro OR NEW.is_pro IS NULL)
);

-- Service role can manage all profiles
CREATE POLICY "Service role can manage all profiles"
ON profiles FOR ALL
USING (auth.role() = 'service_role');

-- Function to check if user is pro (for use in other policies)
CREATE OR REPLACE FUNCTION is_user_pro()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT is_pro FROM profiles WHERE id = auth.uid();
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION is_user_pro() TO authenticated;
