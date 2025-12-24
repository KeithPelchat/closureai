-- Migration: Create prompts table for versioned AI prompts per coach
-- Run: psql $DATABASE_URL -f scripts/migrations/007_create_prompts.sql

CREATE TABLE IF NOT EXISTS prompts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  prompt_text TEXT NOT NULL,
  is_active BOOLEAN DEFAULT FALSE,
  created_by UUID,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_prompts_app ON prompts(app_id);
CREATE INDEX IF NOT EXISTS idx_prompts_app_active ON prompts(app_id, is_active) WHERE is_active = TRUE;

-- Unique constraint: one active prompt per app
CREATE UNIQUE INDEX IF NOT EXISTS uq_prompts_app_active
  ON prompts(app_id)
  WHERE is_active = TRUE;

-- Unique constraint: version number per app
ALTER TABLE prompts
  ADD CONSTRAINT uq_prompts_app_version
  UNIQUE (app_id, version);

COMMENT ON TABLE prompts IS 'Versioned AI system prompts per coach - admin-managed';
COMMENT ON COLUMN prompts.version IS 'Sequential version number (1, 2, 3...)';
COMMENT ON COLUMN prompts.is_active IS 'Only one prompt per app can be active';
COMMENT ON COLUMN prompts.created_by IS 'Admin user who created this version';
COMMENT ON COLUMN prompts.notes IS 'Admin notes about what changed in this version';

-- Migrate existing custom_system_prompt from apps table to prompts table
INSERT INTO prompts (app_id, version, prompt_text, is_active, notes, created_at)
SELECT
  id,
  1,
  custom_system_prompt,
  TRUE,
  'Migrated from apps.custom_system_prompt',
  NOW()
FROM apps
WHERE custom_system_prompt IS NOT NULL
  AND custom_system_prompt != ''
ON CONFLICT (app_id, version) DO NOTHING;
