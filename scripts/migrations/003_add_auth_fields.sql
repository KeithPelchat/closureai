-- Migration: Add authentication fields to apps and users tables
-- Run: psql $DATABASE_URL -f scripts/migrations/003_add_auth_fields.sql

-- =============================================
-- APPS TABLE: Auth + Coach Stripe fields
-- =============================================

-- Auth fields for coach login
ALTER TABLE apps ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS google_id VARCHAR(255);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;

-- Coach's own Stripe keys (for charging their users)
ALTER TABLE apps ADD COLUMN IF NOT EXISTS coach_stripe_secret_key VARCHAR(500);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS coach_stripe_publishable_key VARCHAR(500);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS charge_users BOOLEAN DEFAULT FALSE;

-- Interaction settings
ALTER TABLE apps ADD COLUMN IF NOT EXISTS interaction_limit INTEGER DEFAULT 6;

-- Partner referral tracking
ALTER TABLE apps ADD COLUMN IF NOT EXISTS partner_id UUID;

-- Index for Google OAuth lookup
CREATE INDEX IF NOT EXISTS idx_apps_google_id ON apps(google_id) WHERE google_id IS NOT NULL;

-- =============================================
-- USERS TABLE: Auth fields
-- =============================================

-- Auth fields for end user login
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active';

-- Index for Google OAuth lookup
CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL;

-- Index for status filtering
CREATE INDEX IF NOT EXISTS idx_users_status ON users(app_id, status);

COMMENT ON COLUMN apps.coach_stripe_secret_key IS 'Encrypted Stripe secret key for coach to charge their users';
COMMENT ON COLUMN apps.coach_stripe_publishable_key IS 'Stripe publishable key for coach frontend';
COMMENT ON COLUMN apps.charge_users IS 'If true, users must pay to access (using coach Stripe keys)';
COMMENT ON COLUMN apps.interaction_limit IS 'Max turns per session (default 6, max 8)';
COMMENT ON COLUMN users.status IS 'User status: active, inactive';
