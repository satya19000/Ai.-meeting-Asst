-- ═══════════════════════════════════════════════════════════
--  MeetIQ AI  —  PostgreSQL Schema  (v1.0)
--  Covers: users, meetings, bot sessions, transcripts,
--          summaries, action items, slides, notifications
-- ═══════════════════════════════════════════════════════════

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";      -- fuzzy text search
CREATE EXTENSION IF NOT EXISTS "unaccent";     -- Telugu/accent-safe search
CREATE EXTENSION IF NOT EXISTS "pgcrypto";     -- encrypt sensitive fields

-- ─────────────────────────────────────────────────────────────
--  ENUMS
-- ─────────────────────────────────────────────────────────────
CREATE TYPE user_role         AS ENUM ('super_admin', 'district_officer', 'department_staff', 'viewer');
CREATE TYPE meeting_platform  AS ENUM ('zoom', 'google_meet', 'teams', 'webex', 'other');
CREATE TYPE meeting_status    AS ENUM ('scheduled', 'joining', 'live', 'processing', 'done', 'failed', 'cancelled');
CREATE TYPE transcript_lang   AS ENUM ('en', 'te', 'hi', 'mixed');
CREATE TYPE summary_type      AS ENUM ('brief', 'detailed', 'bilingual', 'telugu');
CREATE TYPE action_priority   AS ENUM ('low', 'medium', 'high', 'critical');
CREATE TYPE action_status     AS ENUM ('pending', 'in_progress', 'done', 'overdue', 'cancelled');
CREATE TYPE notif_channel     AS ENUM ('email', 'whatsapp', 'telegram', 'push', 'in_app');
CREATE TYPE notif_status      AS ENUM ('queued', 'sent', 'failed', 'read');
CREATE TYPE export_format     AS ENUM ('pdf', 'docx', 'pptx', 'csv', 'json');

-- ─────────────────────────────────────────────────────────────
--  ORGANISATIONS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE organisations (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          TEXT NOT NULL,
  short_name    TEXT,
  department    TEXT,
  district      TEXT,
  state         TEXT DEFAULT 'Telangana',
  logo_url      TEXT,
  settings      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
--  USERS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID REFERENCES organisations(id) ON DELETE CASCADE,
  full_name       TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  role            user_role NOT NULL DEFAULT 'viewer',
  designation     TEXT,
  department      TEXT,
  phone           TEXT,
  avatar_url      TEXT,
  telegram_chat_id TEXT,
  whatsapp_number  TEXT,
  is_active       BOOLEAN DEFAULT TRUE,
  last_login_at   TIMESTAMPTZ,
  email_verified  BOOLEAN DEFAULT FALSE,
  two_fa_secret   TEXT,                  -- TOTP secret (encrypted)
  two_fa_enabled  BOOLEAN DEFAULT FALSE,
  preferences     JSONB DEFAULT '{}',    -- theme, language, notifications
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email   ON users(email);
CREATE INDEX idx_users_org     ON users(org_id);
CREATE INDEX idx_users_role    ON users(role);

-- ─────────────────────────────────────────────────────────────
--  REFRESH TOKENS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  device_info JSONB,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_rt_user    ON refresh_tokens(user_id);
CREATE INDEX idx_rt_expires ON refresh_tokens(expires_at);

-- ─────────────────────────────────────────────────────────────
--  MEETINGS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE meetings (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID REFERENCES organisations(id) ON DELETE CASCADE,
  created_by      UUID NOT NULL REFERENCES users(id),
  title           TEXT NOT NULL,
  description     TEXT,
  platform        meeting_platform NOT NULL,
  status          meeting_status NOT NULL DEFAULT 'scheduled',

  -- connection details (encrypted at app layer)
  meeting_link    TEXT,
  meeting_id      TEXT,
  passcode        TEXT,
  host_email      TEXT,

  -- scheduling
  scheduled_at    TIMESTAMPTZ,
  started_at      TIMESTAMPTZ,
  ended_at        TIMESTAMPTZ,
  duration_secs   INTEGER GENERATED ALWAYS AS (
                    EXTRACT(EPOCH FROM (ended_at - started_at))::INTEGER
                  ) STORED,

  -- recording
  recording_url   TEXT,          -- S3 key
  recording_size  BIGINT,        -- bytes
  recording_key   TEXT,          -- AES-256 key ref

  -- ai processing
  ai_processed    BOOLEAN DEFAULT FALSE,
  ai_processed_at TIMESTAMPTZ,
  transcript_lang transcript_lang DEFAULT 'mixed',
  slide_count     INTEGER DEFAULT 0,
  participant_count INTEGER DEFAULT 0,

  -- metadata
  venue           TEXT,
  agenda          TEXT[],
  tags            TEXT[],
  is_private      BOOLEAN DEFAULT FALSE,
  metadata        JSONB DEFAULT '{}',

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_meetings_org        ON meetings(org_id);
CREATE INDEX idx_meetings_status     ON meetings(status);
CREATE INDEX idx_meetings_platform   ON meetings(platform);
CREATE INDEX idx_meetings_created_by ON meetings(created_by);
CREATE INDEX idx_meetings_scheduled  ON meetings(scheduled_at);
CREATE INDEX idx_meetings_title_trgm ON meetings USING GIN(title gin_trgm_ops);
CREATE INDEX idx_meetings_tags       ON meetings USING GIN(tags);

-- ─────────────────────────────────────────────────────────────
--  MEETING PARTICIPANTS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE meeting_participants (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  meeting_id    UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES users(id),          -- NULL if external
  display_name  TEXT NOT NULL,
  email         TEXT,
  role          TEXT DEFAULT 'attendee',             -- host | co-host | attendee
  joined_at     TIMESTAMPTZ,
  left_at       TIMESTAMPTZ,
  duration_secs INTEGER GENERATED ALWAYS AS (
                  EXTRACT(EPOCH FROM (left_at - joined_at))::INTEGER
                ) STORED,
  is_bot        BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_participants_meeting ON meeting_participants(meeting_id);
CREATE INDEX idx_participants_user    ON meeting_participants(user_id);

-- ─────────────────────────────────────────────────────────────
--  BOT SESSIONS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE bot_sessions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  meeting_id    UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  bot_name      TEXT DEFAULT 'MeetIQ Recorder',
  status        TEXT DEFAULT 'idle',    -- idle|joining|active|paused|ended|error
  joined_at     TIMESTAMPTZ,
  left_at       TIMESTAMPTZ,
  error_message TEXT,
  worker_id     TEXT,                   -- which bot worker pod handled this
  screenshots   INTEGER DEFAULT 0,
  bytes_recorded BIGINT DEFAULT 0,
  log           JSONB DEFAULT '[]',     -- timeline of bot events
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bot_meeting ON bot_sessions(meeting_id);
CREATE INDEX idx_bot_status  ON bot_sessions(status);

-- ─────────────────────────────────────────────────────────────
--  TRANSCRIPTS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE transcripts (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  meeting_id    UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  engine        TEXT DEFAULT 'whisper',   -- whisper|deepgram|assemblyai|google
  language      transcript_lang DEFAULT 'en',
  is_final      BOOLEAN DEFAULT FALSE,
  word_count    INTEGER DEFAULT 0,
  duration_secs INTEGER DEFAULT 0,
  confidence    NUMERIC(4,3),             -- 0.000–1.000
  raw_json      JSONB,                    -- full engine response
  full_text     TEXT,                     -- plain concatenated text
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_transcripts_meeting  ON transcripts(meeting_id);
CREATE INDEX idx_transcripts_fulltext ON transcripts USING GIN(to_tsvector('english', COALESCE(full_text,'')));

-- ─────────────────────────────────────────────────────────────
--  TRANSCRIPT SEGMENTS  (individual speaker turns)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE transcript_segments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transcript_id   UUID NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  meeting_id      UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  speaker_label   TEXT,                -- "Speaker 1", "DMHO", etc.
  speaker_user_id UUID REFERENCES users(id),
  start_ms        INTEGER NOT NULL,    -- milliseconds from meeting start
  end_ms          INTEGER NOT NULL,
  text            TEXT NOT NULL,
  language        TEXT DEFAULT 'en',   -- per-segment language
  confidence      NUMERIC(4,3),
  words           JSONB,               -- word-level timestamps
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_segments_transcript ON transcript_segments(transcript_id);
CREATE INDEX idx_segments_meeting    ON transcript_segments(meeting_id);
CREATE INDEX idx_segments_speaker    ON transcript_segments(speaker_label);
CREATE INDEX idx_segments_text       ON transcript_segments USING GIN(to_tsvector('english', text));

-- ─────────────────────────────────────────────────────────────
--  SUMMARIES
-- ─────────────────────────────────────────────────────────────
CREATE TABLE summaries (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  meeting_id      UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  type            summary_type NOT NULL DEFAULT 'brief',
  language        TEXT DEFAULT 'en',
  model           TEXT DEFAULT 'gpt-4-turbo',
  content         TEXT NOT NULL,
  content_telugu  TEXT,
  token_count     INTEGER,
  quality_score   NUMERIC(4,3),         -- AI self-rated 0-1
  key_topics      TEXT[],
  key_persons     TEXT[],
  keywords        TEXT[],
  decisions       TEXT[],
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_summaries_meeting ON summaries(meeting_id);
CREATE INDEX idx_summaries_type    ON summaries(type);

-- ─────────────────────────────────────────────────────────────
--  ACTION ITEMS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE action_items (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  meeting_id      UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  org_id          UUID REFERENCES organisations(id),
  created_by      UUID REFERENCES users(id),

  task            TEXT NOT NULL,
  task_telugu     TEXT,
  description     TEXT,

  assigned_to     UUID REFERENCES users(id),
  assigned_name   TEXT,                  -- free-text if user not in system
  department      TEXT,

  priority        action_priority DEFAULT 'medium',
  status          action_status DEFAULT 'pending',

  due_date        DATE,
  completed_at    TIMESTAMPTZ,
  reminder_sent   BOOLEAN DEFAULT FALSE,
  reminder_at     TIMESTAMPTZ,

  source_segment_id UUID REFERENCES transcript_segments(id),
  confidence      NUMERIC(4,3),          -- AI confidence this is an action

  notes           TEXT,
  metadata        JSONB DEFAULT '{}',

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_actions_meeting    ON action_items(meeting_id);
CREATE INDEX idx_actions_assigned   ON action_items(assigned_to);
CREATE INDEX idx_actions_status     ON action_items(status);
CREATE INDEX idx_actions_due        ON action_items(due_date);
CREATE INDEX idx_actions_priority   ON action_items(priority);

-- ─────────────────────────────────────────────────────────────
--  SLIDES / SCREEN CAPTURES
-- ─────────────────────────────────────────────────────────────
CREATE TABLE slide_captures (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  meeting_id      UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  slide_number    INTEGER NOT NULL,
  captured_at_ms  INTEGER,               -- ms from meeting start
  image_url       TEXT NOT NULL,          -- S3 key
  thumbnail_url   TEXT,
  ocr_text        TEXT,                   -- extracted text
  ai_title        TEXT,                   -- AI-generated slide title
  ai_notes        TEXT,                   -- AI discussion notes for slide
  ai_notes_telugu TEXT,
  confidence      NUMERIC(4,3),
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_slides_meeting ON slide_captures(meeting_id);
CREATE INDEX idx_slides_ocr     ON slide_captures USING GIN(to_tsvector('english', COALESCE(ocr_text,'')));

-- ─────────────────────────────────────────────────────────────
--  MINUTES OF MEETING  (structured MoM document)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE minutes_of_meeting (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  meeting_id      UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  generated_by    UUID REFERENCES users(id),
  model           TEXT DEFAULT 'gpt-4-turbo',

  -- Document fields
  title           TEXT NOT NULL,
  date_time       TIMESTAMPTZ,
  venue           TEXT,
  chaired_by      TEXT,

  agenda_items    JSONB DEFAULT '[]',
  discussion_points JSONB DEFAULT '[]',
  decisions       JSONB DEFAULT '[]',
  action_items    JSONB DEFAULT '[]',    -- snapshot of actions at generation time
  next_meeting    JSONB,

  -- Generated documents (S3 keys)
  pdf_url         TEXT,
  docx_url        TEXT,
  pptx_url        TEXT,

  -- Telugu version
  content_telugu  JSONB,

  is_approved     BOOLEAN DEFAULT FALSE,
  approved_by     UUID REFERENCES users(id),
  approved_at     TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_mom_meeting ON minutes_of_meeting(meeting_id);

-- ─────────────────────────────────────────────────────────────
--  EXPORTS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE exports (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  meeting_id    UUID REFERENCES meetings(id) ON DELETE SET NULL,
  requested_by  UUID NOT NULL REFERENCES users(id),
  format        export_format NOT NULL,
  status        TEXT DEFAULT 'queued',   -- queued|processing|done|failed
  file_url      TEXT,
  file_size     BIGINT,
  options       JSONB DEFAULT '{}',
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);

CREATE INDEX idx_exports_meeting ON exports(meeting_id);
CREATE INDEX idx_exports_user    ON exports(requested_by);

-- ─────────────────────────────────────────────────────────────
--  NOTIFICATIONS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE notifications (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  meeting_id    UUID REFERENCES meetings(id) ON DELETE SET NULL,
  channel       notif_channel NOT NULL,
  status        notif_status DEFAULT 'queued',
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  data          JSONB DEFAULT '{}',
  sent_at       TIMESTAMPTZ,
  read_at       TIMESTAMPTZ,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifs_user    ON notifications(user_id);
CREATE INDEX idx_notifs_status  ON notifications(status);
CREATE INDEX idx_notifs_channel ON notifications(channel);

-- ─────────────────────────────────────────────────────────────
--  AUDIT LOG
-- ─────────────────────────────────────────────────────────────
CREATE TABLE audit_log (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  org_id      UUID REFERENCES organisations(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,           -- MEETING_CREATED, EXPORT_PDF, etc.
  resource    TEXT,                    -- meetings, users, etc.
  resource_id UUID,
  ip_address  INET,
  user_agent  TEXT,
  old_value   JSONB,
  new_value   JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_user     ON audit_log(user_id);
CREATE INDEX idx_audit_action   ON audit_log(action);
CREATE INDEX idx_audit_resource ON audit_log(resource, resource_id);
CREATE INDEX idx_audit_created  ON audit_log(created_at DESC);

-- ─────────────────────────────────────────────────────────────
--  SEARCH CACHE  (pre-computed FTS vectors)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE search_index (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  resource    TEXT NOT NULL,          -- meetings | transcripts | action_items
  resource_id UUID NOT NULL,
  org_id      UUID REFERENCES organisations(id) ON DELETE CASCADE,
  title       TEXT,
  body        TEXT,
  tags        TEXT[],
  tsv         TSVECTOR,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_search_tsv     ON search_index USING GIN(tsv);
CREATE INDEX idx_search_org     ON search_index(org_id);
CREATE INDEX idx_search_resource ON search_index(resource, resource_id);

-- ─────────────────────────────────────────────────────────────
--  UPDATED_AT TRIGGER  (auto-update all tables)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'organisations','users','meetings','bot_sessions',
    'transcripts','summaries','action_items',
    'minutes_of_meeting','exports'
  ]) LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%I_updated BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t
    );
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────
--  FULL-TEXT SEARCH TRIGGER ON MEETINGS
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_meeting_search()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO search_index(resource, resource_id, org_id, title, body, tsv)
  VALUES (
    'meetings', NEW.id, NEW.org_id,
    NEW.title,
    COALESCE(NEW.description,'') || ' ' || array_to_string(COALESCE(NEW.tags,'{}'),' '),
    to_tsvector('english',
      COALESCE(NEW.title,'') || ' ' ||
      COALESCE(NEW.description,'') || ' ' ||
      array_to_string(COALESCE(NEW.agenda,'{}'),' ')
    )
  )
  ON CONFLICT (resource, resource_id) DO UPDATE SET
    title = EXCLUDED.title, body = EXCLUDED.body,
    tsv = EXCLUDED.tsv, updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE UNIQUE INDEX idx_search_unique ON search_index(resource, resource_id);

CREATE TRIGGER trg_meeting_search
  AFTER INSERT OR UPDATE ON meetings
  FOR EACH ROW EXECUTE FUNCTION update_meeting_search();

-- ─────────────────────────────────────────────────────────────
--  VIEWS  — convenient read models
-- ─────────────────────────────────────────────────────────────
CREATE VIEW v_meeting_overview AS
SELECT
  m.id, m.org_id, m.title, m.platform, m.status,
  m.scheduled_at, m.started_at, m.ended_at, m.duration_secs,
  m.slide_count, m.participant_count,
  u.full_name AS created_by_name,
  (SELECT COUNT(*) FROM action_items a WHERE a.meeting_id = m.id AND a.status != 'done')  AS pending_actions,
  (SELECT COUNT(*) FROM action_items a WHERE a.meeting_id = m.id)                         AS total_actions,
  (SELECT COUNT(*) FROM transcript_segments ts WHERE ts.meeting_id = m.id)               AS segment_count,
  (SELECT s.type IS NOT NULL FROM summaries s WHERE s.meeting_id = m.id LIMIT 1)         AS has_summary,
  (SELECT mom.id IS NOT NULL FROM minutes_of_meeting mom WHERE mom.meeting_id = m.id LIMIT 1) AS has_mom
FROM meetings m
JOIN users u ON u.id = m.created_by;

CREATE VIEW v_overdue_actions AS
SELECT a.*, m.title AS meeting_title, u.full_name AS assigned_to_name, u.email AS assigned_email
FROM action_items a
JOIN meetings m ON m.id = a.meeting_id
LEFT JOIN users u ON u.id = a.assigned_to
WHERE a.status NOT IN ('done','cancelled')
  AND a.due_date < CURRENT_DATE;

COMMENT ON TABLE meetings          IS 'Core meeting records — all platforms';
COMMENT ON TABLE bot_sessions      IS 'AI bot join/record sessions per meeting';
COMMENT ON TABLE transcripts       IS 'Full transcript documents per meeting';
COMMENT ON TABLE transcript_segments IS 'Speaker-diarized individual utterances';
COMMENT ON TABLE summaries         IS 'AI-generated summaries (brief/detailed/telugu)';
COMMENT ON TABLE action_items      IS 'AI-extracted action items with assignments';
COMMENT ON TABLE slide_captures    IS 'Screenshot captures with OCR and AI notes';
COMMENT ON TABLE minutes_of_meeting IS 'Structured MoM documents with export URLs';
