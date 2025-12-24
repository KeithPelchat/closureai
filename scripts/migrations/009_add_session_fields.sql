-- Migration: Add summary and status fields to sessions table
-- Run: psql $DATABASE_URL -f scripts/migrations/009_add_session_fields.sql

-- Session status tracking
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active';

-- Turn count (aggregated from interactions)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS turn_count INTEGER DEFAULT 0;

-- AI-generated session summary
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS summary TEXT;

-- When session was closed
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP WITH TIME ZONE;

-- Index for status filtering
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_app_status ON sessions(app_id, status);

-- Constraint for valid status values
ALTER TABLE sessions
  ADD CONSTRAINT chk_session_status
  CHECK (status IN ('active', 'completed', 'abandoned'));

COMMENT ON COLUMN sessions.status IS 'Session status: active, completed, abandoned';
COMMENT ON COLUMN sessions.turn_count IS 'Number of completed turns in this session';
COMMENT ON COLUMN sessions.summary IS 'AI-generated summary of the session';
COMMENT ON COLUMN sessions.closed_at IS 'When session was closed (completed or abandoned)';
