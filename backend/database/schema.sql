-- DocuVision SQLite schema (idempotent: safe to run on every start).
-- Timestamps are ISO-8601 UTC strings written by the application.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE COLLATE NOCASE CHECK (length(email) BETWEEN 3 AND 254),
  password_hash TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id                  INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_preset           TEXT    NOT NULL DEFAULT 'automatic'
                           CHECK (default_preset IN ('automatic','document_scan','black_white','grayscale','custom')),
  default_document_type    TEXT    NOT NULL DEFAULT 'general' CHECK (default_document_type IN ('general','form')),
  export_reflow            INTEGER NOT NULL DEFAULT 1 CHECK (export_reflow IN (0,1)),
  export_include_full_text INTEGER NOT NULL DEFAULT 1 CHECK (export_include_full_text IN (0,1)),
  export_filename_suffix   TEXT    NOT NULL DEFAULT '_digitized' CHECK (length(export_filename_suffix) <= 40),
  updated_at               TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  original_filename    TEXT    NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 255),
  stored_filename      TEXT    NOT NULL UNIQUE,            -- server generated: <uuid>.<jpg|png>
  original_image_path  TEXT    NOT NULL,                   -- storage key, e.g. uploads/<uuid>.jpg
  corrected_image_path TEXT,                               -- perspective/orientation/deskew corrected page
  enhanced_image_path  TEXT,                               -- DSP-enhanced page (what OCR reads)
  mime_type            TEXT    NOT NULL CHECK (mime_type IN ('image/jpeg','image/png')),
  file_size            INTEGER NOT NULL CHECK (file_size > 0),
  image_width          INTEGER,
  image_height         INTEGER,
  document_type        TEXT    NOT NULL DEFAULT 'general' CHECK (document_type IN ('general','form')),
  processing_status    TEXT    NOT NULL DEFAULT 'uploaded'
                       CHECK (processing_status IN ('uploaded','processing','processed','failed')),
  review_status        TEXT    NOT NULL DEFAULT 'not_started'
                       CHECK (review_status IN ('not_started','needs_review','reviewed')),
  corners_json         TEXT,                               -- last corners (original pixel coordinates)
  geometry_json        TEXT,                               -- last geometry options + report
  enhancement_json     TEXT,                               -- last resolved enhancement parameters + report
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_user_created ON documents(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_user_status  ON documents(user_id, processing_status);

CREATE TABLE IF NOT EXISTS processing_jobs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id         INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  kind                TEXT    NOT NULL DEFAULT 'process' CHECK (kind IN ('process','ocr')),
  processing_settings TEXT    NOT NULL DEFAULT '{}',        -- JSON
  status              TEXT    NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
  stage               TEXT,                                 -- geometry | enhancement | ocr | done
  stage_timings       TEXT,                                 -- JSON {geometry_ms, enhancement_ms, ocr_ms}
  processing_time_ms  INTEGER,
  error_message       TEXT,
  created_at          TEXT    NOT NULL,
  completed_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_document ON processing_jobs(document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status   ON processing_jobs(status);
-- At most ONE active job per document (prevents accidental duplicate processing at the database level).
CREATE UNIQUE INDEX IF NOT EXISTS ux_jobs_one_active_per_document
  ON processing_jobs(document_id) WHERE status IN ('queued','running');

CREATE TABLE IF NOT EXISTS ocr_results (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id             INTEGER NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
  original_extracted_text TEXT    NOT NULL DEFAULT '',
  corrected_text          TEXT    NOT NULL DEFAULT '',
  confidence_score        REAL,                              -- mean Tesseract word confidence (self-reported, not accuracy)
  bounding_boxes_json     TEXT    NOT NULL DEFAULT '[]',     -- word boxes in enhanced-image pixels
  structured_fields_json  TEXT,                              -- template form result (fields incl. original_value)
  ocr_meta_json           TEXT,                              -- psm, image size, confidence summary, warnings
  updated_at              TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS document_exports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  export_type TEXT    NOT NULL CHECK (export_type IN ('text','form')),
  filename    TEXT    NOT NULL,                              -- name offered on download
  file_path   TEXT    NOT NULL UNIQUE,                       -- storage key, e.g. exports/<uuid>.docx
  created_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exports_document ON document_exports(document_id, created_at DESC);

CREATE TABLE IF NOT EXISTS experiment_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id    INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  reference_text TEXT,
  settings_json  TEXT    NOT NULL DEFAULT '{}',
  results_json   TEXT    NOT NULL,
  created_at     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_experiments_document ON experiment_runs(document_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  sid     TEXT    PRIMARY KEY,
  sess    TEXT    NOT NULL,
  expires INTEGER NOT NULL                                   -- epoch milliseconds
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
