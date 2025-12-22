-- Migration: Add admin flag to users table
-- Run with: psql $DATABASE_URL -f scripts/migrations/001_add_admin_flag.sql

-- Add is_admin column (defaults to false for all existing users)
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

-- Create index for efficient admin lookups
CREATE INDEX IF NOT EXISTS idx_users_app_admin ON users(app_id, is_admin) WHERE is_admin = true;

-- Verify the column was added
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'users' AND column_name = 'is_admin';
