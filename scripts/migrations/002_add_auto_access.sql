-- Migration: Add auto_grant_access_days to apps table
-- Run this with admin credentials:
-- psql $DATABASE_URL -f scripts/migrations/002_add_auto_access.sql

-- Add column to control automatic access for new users
ALTER TABLE apps ADD COLUMN IF NOT EXISTS auto_grant_access_days INTEGER DEFAULT NULL;
COMMENT ON COLUMN apps.auto_grant_access_days IS 'If set, new users automatically get access for this many days';

-- Example: Give Wendy's users 30 days automatic access
-- UPDATE apps SET auto_grant_access_days = 30 WHERE subdomain = 'wendyai';
