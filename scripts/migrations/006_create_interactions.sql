-- Migration: Create interactions table for per-turn storage
-- Run: psql $DATABASE_URL -f scripts/migrations/006_create_interactions.sql

CREATE TABLE IF NOT EXISTS interactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL,
  user_message TEXT NOT NULL,
  ai_response TEXT NOT NULL,
  offer_shown VARCHAR(255),
  tokens_used INTEGER,
  response_time_ms INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_interactions_session ON interactions(session_id);
CREATE INDEX IF NOT EXISTS idx_interactions_session_turn ON interactions(session_id, turn_number);

-- Unique constraint: one interaction per turn per session
ALTER TABLE interactions
  ADD CONSTRAINT uq_interactions_session_turn
  UNIQUE (session_id, turn_number);

COMMENT ON TABLE interactions IS 'Individual turns within AI conversation sessions';
COMMENT ON COLUMN interactions.turn_number IS 'Sequential turn number within session (1, 2, 3...)';
COMMENT ON COLUMN interactions.offer_shown IS 'Which offer was presented in this turn, if any';
COMMENT ON COLUMN interactions.tokens_used IS 'OpenAI tokens consumed for this turn';
COMMENT ON COLUMN interactions.response_time_ms IS 'AI response time in milliseconds';
