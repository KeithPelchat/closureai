-- Migration: Create commissions table for partner earnings tracking
-- Run: psql $DATABASE_URL -f scripts/migrations/005_create_commissions.sql

CREATE TABLE IF NOT EXISTS commissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  paid_at TIMESTAMP WITH TIME ZONE,
  period_start DATE,
  period_end DATE,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_commissions_partner ON commissions(partner_id);
CREATE INDEX IF NOT EXISTS idx_commissions_client ON commissions(client_id);
CREATE INDEX IF NOT EXISTS idx_commissions_status ON commissions(status);
CREATE INDEX IF NOT EXISTS idx_commissions_type ON commissions(type);

-- Constraint for valid types
ALTER TABLE commissions
  ADD CONSTRAINT chk_commission_type
  CHECK (type IN ('setup_fee', 'monthly'));

-- Constraint for valid status
ALTER TABLE commissions
  ADD CONSTRAINT chk_commission_status
  CHECK (status IN ('pending', 'paid', 'cancelled'));

COMMENT ON TABLE commissions IS 'Tracks partner earnings from referred coaches';
COMMENT ON COLUMN commissions.type IS 'Commission type: setup_fee (one-time) or monthly (recurring)';
COMMENT ON COLUMN commissions.amount IS 'Commission amount in USD';
COMMENT ON COLUMN commissions.period_start IS 'For monthly commissions, the billing period start';
COMMENT ON COLUMN commissions.period_end IS 'For monthly commissions, the billing period end';
