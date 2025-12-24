-- Migration: Create email_verification_tokens table
-- Run: psql $DATABASE_URL -f scripts/migrations/010_create_email_verification_tokens.sql

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_type VARCHAR(50) NOT NULL,
  user_id UUID NOT NULL,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  used_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_email_verify_token ON email_verification_tokens(token);
CREATE INDEX IF NOT EXISTS idx_email_verify_user ON email_verification_tokens(user_type, user_id);
CREATE INDEX IF NOT EXISTS idx_email_verify_expires ON email_verification_tokens(expires_at);

-- Constraint for valid user types
ALTER TABLE email_verification_tokens
  ADD CONSTRAINT chk_verify_user_type
  CHECK (user_type IN ('user', 'client', 'partner'));

COMMENT ON TABLE email_verification_tokens IS 'Tokens for email verification flow across all user types';
COMMENT ON COLUMN email_verification_tokens.user_type IS 'Which table the user_id refers to: user, client (apps), partner';
COMMENT ON COLUMN email_verification_tokens.token IS 'Unique token sent via email';
COMMENT ON COLUMN email_verification_tokens.expires_at IS 'Token expires after 24 hours';
COMMENT ON COLUMN email_verification_tokens.used_at IS 'Set when token is successfully used';
