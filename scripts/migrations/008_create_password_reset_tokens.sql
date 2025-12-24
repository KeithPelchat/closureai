-- Migration: Create password_reset_tokens table
-- Run: psql $DATABASE_URL -f scripts/migrations/008_create_password_reset_tokens.sql

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_type VARCHAR(50) NOT NULL,
  user_id UUID NOT NULL,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  used_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_password_reset_token ON password_reset_tokens(token);
CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_type, user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_expires ON password_reset_tokens(expires_at);

-- Constraint for valid user types
ALTER TABLE password_reset_tokens
  ADD CONSTRAINT chk_reset_user_type
  CHECK (user_type IN ('user', 'client', 'partner'));

COMMENT ON TABLE password_reset_tokens IS 'Tokens for password reset flow across all user types';
COMMENT ON COLUMN password_reset_tokens.user_type IS 'Which table the user_id refers to: user, client (apps), partner';
COMMENT ON COLUMN password_reset_tokens.token IS 'Hashed token sent via email';
COMMENT ON COLUMN password_reset_tokens.expires_at IS 'Token expires after 1 hour';
COMMENT ON COLUMN password_reset_tokens.used_at IS 'Set when token is successfully used';
