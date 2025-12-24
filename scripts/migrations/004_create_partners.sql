-- Migration: Create partners table for affiliate/referral tracking
-- Run: psql $DATABASE_URL -f scripts/migrations/004_create_partners.sql

CREATE TABLE IF NOT EXISTS partners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255),
  google_id VARCHAR(255),
  email_verified BOOLEAN DEFAULT FALSE,
  referral_code VARCHAR(50) UNIQUE NOT NULL,
  commission_percent DECIMAL(5,2) DEFAULT 30.00,
  payment_method VARCHAR(50),
  payment_handle VARCHAR(255),
  status VARCHAR(50) DEFAULT 'active',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_partners_email ON partners(email);
CREATE INDEX IF NOT EXISTS idx_partners_referral_code ON partners(referral_code);
CREATE INDEX IF NOT EXISTS idx_partners_google_id ON partners(google_id) WHERE google_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_partners_status ON partners(status);

-- Add foreign key from apps to partners (for referral tracking)
-- Note: partner_id column added in 003_add_auth_fields.sql
ALTER TABLE apps
  ADD CONSTRAINT fk_apps_partner
  FOREIGN KEY (partner_id)
  REFERENCES partners(id)
  ON DELETE SET NULL;

COMMENT ON TABLE partners IS 'Affiliates who refer coaches to the platform';
COMMENT ON COLUMN partners.referral_code IS 'Unique code for referral URLs: /onboard?ref=CODE';
COMMENT ON COLUMN partners.commission_percent IS 'Percentage of setup fee and monthly revenue shared';
COMMENT ON COLUMN partners.payment_method IS 'How to pay partner: venmo:@handle or paypal:email';
