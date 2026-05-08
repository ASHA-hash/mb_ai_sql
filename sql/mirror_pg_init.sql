-- Run once on your PostgreSQL mirror (replace YOUR_DB with actual database name).
-- Or let `npm run mirror-sync` create this table automatically.

-- CREATE DATABASE YOUR_DB;

CREATE TABLE IF NOT EXISTS erp_mirror_snapshots (
  dataset_key TEXT PRIMARY KEY,
  row_count INTEGER NOT NULL,
  payload JSONB NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS erp_mirror_snapshots_synced_at_idx
  ON erp_mirror_snapshots (synced_at DESC);
