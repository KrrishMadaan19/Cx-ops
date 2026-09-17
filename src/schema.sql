-- Core objects, matching the data model in the project README.
-- One row per WhatsApp conversation/ticket (FlowCall calls these "tickets").
CREATE TABLE IF NOT EXISTS conversations (
  id                TEXT PRIMARY KEY,       -- FlowCall ticket ID
  customer_name     TEXT,
  customer_phone    TEXT,                   -- FlowCall's real "Customer Phone" column
  order_id          TEXT,
  channel           TEXT DEFAULT 'whatsapp',
  flow              TEXT,                   -- e.g. "Refund & return", "Order tracking"
  started_at        TEXT NOT NULL,          -- ISO timestamp
  ended_at          TEXT,
  status            TEXT,                   -- e.g. "responded", "in_progress", "missed"
  owner_type        TEXT CHECK (owner_type IN ('bot', 'human')),
  owner_agent_id    TEXT,                   -- set once a human agent is involved
  assigned_at       TEXT,                   -- FlowCall's real "Assigned At" -- the actual handoff moment,
                                             -- distinct from started_at (unlike first_response/resolved_by,
                                             -- this and has_agent_actioned genuinely update live, not just
                                             -- at ticket closure -- confirmed against a live export).
  has_agent_actioned INTEGER,               -- 1/0 from FlowCall's real "Has Agent Actioned" -- the live
                                             -- signal for "has the assigned agent done anything yet"
  resolved_by       TEXT CHECK (resolved_by IN ('bot', 'human', NULL)),
  first_response_seconds INTEGER,
  resolution_seconds INTEGER,
  intent            TEXT,
  bot_confidence    REAL,                   -- 0.0 - 1.0, from the bot flow
  sentiment_final   TEXT,                   -- mock data: "positive"/"neutral"/"frustrated"/"angry".
                                             -- real FlowCall data: a comma-joined set of behavioural
                                             -- tags instead (e.g. "askingForAgent, highlyFrustratedUser,
                                             -- AI Disabled") -- see insightsEngine.js's TAG_LABELS for
                                             -- the real vocabulary observed so far.
  fcr               TEXT,                   -- First Contact Resolution, as FlowCall reports it (raw, not yet wired into the UI)
  source_updated_at TEXT                    -- last time FlowCall reported a change (for incremental sync)
);
CREATE INDEX IF NOT EXISTS idx_conversations_started_at ON conversations(started_at);
CREATE INDEX IF NOT EXISTS idx_conversations_owner_type ON conversations(owner_type);
CREATE INDEX IF NOT EXISTS idx_conversations_flow ON conversations(flow);

-- One row per handoff event (a conversation can only really have one, but keep it a separate
-- table so a conversation that's re-escalated has a clean history instead of overwritten fields).
CREATE TABLE IF NOT EXISTS handoffs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id     TEXT NOT NULL REFERENCES conversations(id),
  reason              TEXT,
  trigger_turn        INTEGER,
  queue_started_at    TEXT,
  accepted_at         TEXT,
  accepting_agent_id  TEXT,
  outcome             TEXT
);
CREATE INDEX IF NOT EXISTS idx_handoffs_conversation ON handoffs(conversation_id);

-- One row per CSAT response.
CREATE TABLE IF NOT EXISTS csat (
  conversation_id  TEXT PRIMARY KEY REFERENCES conversations(id),
  score            INTEGER,   -- 1-5
  feedback_text    TEXT
);

-- QA/audit findings raised on a conversation (what the Audit Action Centre reviews).
CREATE TABLE IF NOT EXISTS qa_audits (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id),
  issue_category    TEXT,      -- e.g. "sla", "bot", "human" (matches the audit tabs in the UI)
  severity          TEXT,      -- "High" / "Medium" / "Low"
  finding           TEXT,
  status            TEXT DEFAULT 'open'
);
CREATE INDEX IF NOT EXISTS idx_qa_audits_conversation ON qa_audits(conversation_id);
-- The audit list and its counts endpoint both filter on status = 'open'. Without
-- this, each call full-scans every qa_audits row -- on a 20k-row table, polled
-- twice per dashboard refresh, that alone exhausted D1's free read quota.
CREATE INDEX IF NOT EXISTS idx_qa_audits_status ON qa_audits(status, conversation_id);

-- Agent roster. FlowCall/CRM likely doesn't carry all of this (team, coaching score) --
-- this may need to be maintained here directly or synced from an HR/CRM source later.
CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  team            TEXT,
  shift           TEXT
);

-- Your own team's actions on the audit queue. This is data FlowCall will NEVER have --
-- it only exists because your team does something about a flagged conversation.
CREATE TABLE IF NOT EXISTS audit_actions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id),
  action            TEXT NOT NULL,   -- "assigned" | "reviewed" | "reassigned"
  actor             TEXT,            -- who performed the action (until real auth, a free-text name)
  note              TEXT,
  created_at        TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_actions_conversation ON audit_actions(conversation_id);

-- Tracks where the last successful FlowCall sync left off, so each pull only asks for
-- what's new/changed since then (using FlowCall's `updatedAt` timestamp filter) instead
-- of re-exporting the entire ticket history every 10 minutes.
CREATE TABLE IF NOT EXISTS sync_state (
  key    TEXT PRIMARY KEY,
  value  TEXT
);
