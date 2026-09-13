/**
 * Database client + migration runner
 * Uses Supabase Postgres connection for all DB operations.
 */

import { Pool } from 'pg';

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

db.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

// ─── Migration SQL ────────────────────────────────────────────────────────────

const MIGRATION_SQL = `
-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Memories table (§8 schema)
CREATE TABLE IF NOT EXISTS memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  project_id UUID,
  kind TEXT NOT NULL CHECK (kind IN ('preference', 'glossary', 'project', 'correction')),
  content TEXT NOT NULL,
  embedding vector(768),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  disabled BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);
CREATE INDEX IF NOT EXISTS idx_memories_project_id ON memories(project_id);

-- Feedback table (§10 evaluation loop)
CREATE TABLE IF NOT EXISTS feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  suggestion_id TEXT NOT NULL,
  category TEXT NOT NULL,
  accepted BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_user_id ON feedback(user_id);
CREATE INDEX IF NOT EXISTS idx_feedback_accepted ON feedback(accepted);

-- Per-user rate limiting table
CREATE TABLE IF NOT EXISTS rate_limits (
  user_id UUID PRIMARY KEY,
  analyze_count INT DEFAULT 0,
  improve_count INT DEFAULT 0,
  window_start TIMESTAMPTZ DEFAULT NOW()
);
`;

export async function runMigration(): Promise<void> {
  const client = await db.connect();
  try {
    console.log('[DB] Running migration...');
    await client.query(MIGRATION_SQL);
    console.log('[DB] Migration complete.');
  } finally {
    client.release();
  }
}
