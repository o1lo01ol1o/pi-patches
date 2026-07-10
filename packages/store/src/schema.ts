export const migrations: readonly string[] = [
  `
CREATE TABLE sessions (
  id                TEXT PRIMARY KEY,
  cwd               TEXT NOT NULL,
  session_file      TEXT,
  parent_session_id TEXT,
  started_at        INTEGER NOT NULL,
  last_event_at     INTEGER,
  ended_at          INTEGER
);

CREATE TABLE files (
  id               INTEGER PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  path             TEXT NOT NULL,
  rel_path         TEXT NOT NULL,
  baseline_content BLOB,
  baseline_hash    TEXT,
  baseline_missing INTEGER NOT NULL DEFAULT 0,
  first_touched_at INTEGER NOT NULL,
  first_tool       TEXT NOT NULL CHECK (first_tool IN ('edit','write')),
  UNIQUE(session_id, path),
  CHECK ((baseline_missing = 1 AND baseline_content IS NULL AND baseline_hash IS NULL)
      OR (baseline_missing = 0 AND baseline_content IS NOT NULL AND baseline_hash IS NOT NULL))
);

CREATE TABLE patches (
  id                 INTEGER PRIMARY KEY,
  session_id         TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  file_id            INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  seq                INTEGER NOT NULL,
  tool               TEXT NOT NULL CHECK (tool IN ('edit','write')),
  tool_call_id       TEXT,
  unified_patch      TEXT NOT NULL,
  display_diff       TEXT NOT NULL,
  first_changed_line INTEGER,
  pre_hash           TEXT,
  post_hash          TEXT,
  created_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_patches ON patches(session_id, seq);

CREATE TABLE annotations (
  id              INTEGER PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  file_id         INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  anchor_patch_id INTEGER REFERENCES patches(id) ON DELETE CASCADE,
  anchor_hash     TEXT NOT NULL,
  start_line      INTEGER NOT NULL CHECK (start_line >= 1),
  end_line        INTEGER NOT NULL CHECK (end_line >= start_line),
  snippet         TEXT NOT NULL,
  comment         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','queued','sent')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  sent_at         INTEGER,
  batch_id        TEXT,
  CHECK ((status = 'sent' AND sent_at IS NOT NULL AND batch_id IS NOT NULL)
      OR (status <> 'sent' AND sent_at IS NULL AND batch_id IS NULL))
);
CREATE INDEX idx_ann_status ON annotations(session_id, status);
`,
  `
ALTER TABLE annotations RENAME TO annotations_v1;

CREATE TABLE annotations (
  id              INTEGER PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  file_id         INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  anchor_patch_id INTEGER REFERENCES patches(id) ON DELETE CASCADE,
  anchor_hash     TEXT NOT NULL,
  start_line      INTEGER NOT NULL CHECK (start_line >= 1),
  end_line        INTEGER NOT NULL CHECK (end_line >= start_line),
  snippet         TEXT NOT NULL,
  comment         TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'finding' CHECK (kind IN ('finding','callout')),
  priority        TEXT DEFAULT 'P2' CHECK (priority IS NULL OR priority IN ('P0','P1','P2','P3')),
  audience        TEXT NOT NULL DEFAULT 'agent' CHECK (audience IN ('agent','human')),
  fix_intent      INTEGER NOT NULL DEFAULT 0 CHECK (fix_intent IN (0,1)),
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','queued','sent')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  sent_at         INTEGER,
  batch_id        TEXT,
  CHECK ((status = 'sent' AND sent_at IS NOT NULL AND batch_id IS NOT NULL)
      OR (status <> 'sent' AND sent_at IS NULL AND batch_id IS NULL)),
  CHECK ((kind = 'finding' AND priority IS NOT NULL)
      OR (kind = 'callout' AND priority IS NULL AND audience = 'human'))
);

INSERT INTO annotations
  (id, session_id, file_id, anchor_patch_id, anchor_hash, start_line, end_line,
   snippet, comment, kind, priority, audience, fix_intent, status, created_at, updated_at,
   sent_at, batch_id)
SELECT id, session_id, file_id, anchor_patch_id, anchor_hash, start_line, end_line,
       snippet, comment, 'finding', 'P2', 'agent', 0, status, created_at, updated_at,
       sent_at, batch_id
FROM annotations_v1;

DROP TABLE annotations_v1;
CREATE INDEX idx_ann_status ON annotations(session_id, status);
CREATE INDEX idx_ann_role ON annotations(session_id, kind, priority, audience);

CREATE TABLE review_sources (
  fingerprint     TEXT PRIMARY KEY,
  descriptor_json TEXT NOT NULL,
  history_mode    TEXT NOT NULL CHECK (history_mode IN ('squashed','perCommit')),
  created_at      INTEGER NOT NULL
);

CREATE TABLE review_outcomes (
  source_fingerprint TEXT PRIMARY KEY REFERENCES review_sources(fingerprint) ON DELETE RESTRICT,
  verdict            TEXT NOT NULL CHECK (verdict IN ('correct','needsAttention')),
  recorded_at        INTEGER NOT NULL
);

CREATE TABLE analysis_runs (
  id                 TEXT PRIMARY KEY,
  source_fingerprint TEXT NOT NULL REFERENCES review_sources(fingerprint) ON DELETE RESTRICT,
  mode               TEXT NOT NULL CHECK (mode IN ('narrative','implementationReview')),
  provider           TEXT NOT NULL,
  model_id           TEXT NOT NULL,
  thinking_level     TEXT NOT NULL CHECK (thinking_level IN ('off','minimal','low','medium','high','xhigh')),
  prompt_version     TEXT NOT NULL,
  focus              TEXT,
  status             TEXT NOT NULL CHECK (status IN ('running','completed','failed','cancelled')),
  output_json        TEXT,
  raw_output         TEXT,
  review_verdict     TEXT CHECK (review_verdict IS NULL OR review_verdict IN ('correct','needsAttention')),
  error              TEXT,
  started_at         INTEGER NOT NULL,
  completed_at       INTEGER,
  CHECK ((status = 'running' AND completed_at IS NULL AND output_json IS NULL AND error IS NULL)
      OR (status = 'completed' AND completed_at IS NOT NULL AND output_json IS NOT NULL AND error IS NULL)
      OR (status IN ('failed','cancelled') AND completed_at IS NOT NULL AND output_json IS NULL AND error IS NOT NULL)),
  CHECK ((mode = 'narrative' AND review_verdict IS NULL)
      OR mode = 'implementationReview')
);
CREATE INDEX idx_analysis_runs_source ON analysis_runs(source_fingerprint, mode, started_at DESC);

CREATE TABLE analysis_run_documents (
  run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('included','summarized','excluded','failed')),
  detail TEXT,
  PRIMARY KEY(run_id, document_id),
  CHECK ((status IN ('included','summarized') AND detail IS NULL)
      OR (status IN ('excluded','failed') AND detail IS NOT NULL))
);

CREATE TABLE analysis_run_commits (
  run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  commit_sha TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('included','summarized','excluded','failed')),
  detail TEXT,
  PRIMARY KEY(run_id, commit_sha),
  CHECK ((status IN ('included','summarized') AND detail IS NULL)
      OR (status IN ('excluded','failed') AND detail IS NOT NULL))
);
`,
  `
CREATE TABLE source_notes (
  id                 INTEGER PRIMARY KEY,
  source_fingerprint TEXT NOT NULL REFERENCES review_sources(fingerprint) ON DELETE RESTRICT,
  target_session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  document_id        TEXT NOT NULL,
  path               TEXT NOT NULL,
  rel_path           TEXT NOT NULL,
  anchor_hash        TEXT NOT NULL,
  start_line         INTEGER NOT NULL CHECK (start_line >= 1),
  end_line           INTEGER NOT NULL CHECK (end_line >= start_line),
  snippet            TEXT NOT NULL,
  comment            TEXT NOT NULL,
  kind               TEXT NOT NULL DEFAULT 'finding' CHECK (kind IN ('finding','callout')),
  priority           TEXT DEFAULT 'P2' CHECK (priority IS NULL OR priority IN ('P0','P1','P2','P3')),
  audience           TEXT NOT NULL DEFAULT 'agent' CHECK (audience IN ('agent','human')),
  fix_intent         INTEGER NOT NULL DEFAULT 0 CHECK (fix_intent IN (0,1)),
  status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','queued','sent')),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  sent_at            INTEGER,
  batch_id           TEXT,
  CHECK ((status = 'sent' AND sent_at IS NOT NULL AND batch_id IS NOT NULL)
      OR (status <> 'sent' AND sent_at IS NULL AND batch_id IS NULL)),
  CHECK ((kind = 'finding' AND priority IS NOT NULL)
      OR (kind = 'callout' AND priority IS NULL AND audience = 'human'))
);
CREATE INDEX idx_source_notes_source ON source_notes(source_fingerprint, kind, priority, audience, rel_path, start_line);
CREATE INDEX idx_source_notes_queue ON source_notes(target_session_id, status);
`,
  `
ALTER TABLE analysis_runs
ADD COLUMN manifest_json TEXT NOT NULL DEFAULT '{"strategy":"direct","stats":{"files":0,"commits":0,"bytes":0,"diffRows":0,"estimatedTokens":0},"chunks":[],"documentIds":[],"commitShas":[]}';
`
];

export const schemaVersion = migrations.length;
