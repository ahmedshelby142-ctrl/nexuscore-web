import { createClient } from '@supabase/supabase-js';

const url = 'https://oczgqpxeixlrufvevitz.supabase.co';
const anonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9jemdxcHhlaXhscnVmdmV2aXR6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY3NDI4MjUsImV4cCI6MjEwMjMxODgyNX0.zxqFTXj2AEB2Zb2u6_Pe5uASncmwIRLXIBc_jdGxoSM';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!serviceKey) {
  console.log('SUPABASE_SERVICE_ROLE_KEY not set - cannot create test users');
  process.exit(1);
}

const admin = createClient(url, serviceKey);

async function runTests() {
  const timestamp = Date.now();
  const users = [
    { email: `admin-${timestamp}@test.com`, role: 'ADMIN' },
    { email: `accountant-${timestamp}@test.com`, role: 'ACCOUNTANT' },
    { email: `pos-${timestamp}@test.com`, role: 'POS_ECOMMERCE' },
    { email: `ecom-${timestamp}@test.com`, role: 'ECOMMERCE_ONLY' },
    { email: `no-role-${timestamp}@test.com`, role: null }
  ];
  
  const password = 'TestPass123!';
  const createdUsers = [];
  
  for (const u of users) {
    const { data, error } = await admin.auth.admin.createUser({ email: u.email, password, email_confirm: true });
    if (error) { console.log('Create user error:', error.message); continue; }
    createdUsers.push({ ...u, id: data.user.id });
    console.log('Created:', u.email, u.role);
  }
  
  for (const u of createdUsers) {
    const client = createClient(url, anonKey);
    await client.auth.signInWithPassword({ email: u.email, password });
    const { data, error } = await client.rpc('mobile_shortages');
    console.log(`Test ${u.role || 'NO_ROLE'}:`, error?.code || 'OK', data ? `${data.length} rows` : 'no data');
    
    await admin.auth.admin.deleteUser(u.id);
  }
}

runTests().catch(console.error);