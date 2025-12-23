-- Migration: Coach Platform
-- Adds fields for multi-tenant coach SaaS platform

-- Enhance apps table for coach platform
ALTER TABLE apps ADD COLUMN IF NOT EXISTS business_name VARCHAR(255);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS coach_email VARCHAR(255);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS coach_phone VARCHAR(50);

-- Branding
ALTER TABLE apps ADD COLUMN IF NOT EXISTS logo_url VARCHAR(500);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS primary_color VARCHAR(7) DEFAULT '#0ea5e9';
ALTER TABLE apps ADD COLUMN IF NOT EXISTS secondary_color VARCHAR(7) DEFAULT '#38bdf8';

-- Domain
ALTER TABLE apps ADD COLUMN IF NOT EXISTS custom_domain VARCHAR(255);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS subdomain VARCHAR(100);

-- Billing & Status
ALTER TABLE apps ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT false;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'pending_onboarding';
  -- Values: pending_payment, pending_onboarding, pending_review, active, suspended, cancelled
ALTER TABLE apps ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS setup_paid_at TIMESTAMP;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMP;

-- Coach business details (for AI customization)
ALTER TABLE apps ADD COLUMN IF NOT EXISTS coaching_niche VARCHAR(255);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS target_audience TEXT;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS coaching_style TEXT;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS coach_bio TEXT;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS custom_system_prompt TEXT;

-- Onboarding token (for secure form access after payment)
ALTER TABLE apps ADD COLUMN IF NOT EXISTS onboarding_token VARCHAR(64);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS onboarding_token_expires_at TIMESTAMP;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMP;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS onboarding_data JSONB;

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_subdomain ON apps(subdomain) WHERE subdomain IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_custom_domain ON apps(custom_domain) WHERE custom_domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_apps_status ON apps(status);
CREATE INDEX IF NOT EXISTS idx_apps_onboarding_token ON apps(onboarding_token) WHERE onboarding_token IS NOT NULL;
