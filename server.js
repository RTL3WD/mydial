import express from "express";
import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import nodemailer from "nodemailer";
import swaggerUi from "swagger-ui-express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATABASE_PATH = process.env.DATABASE_PATH || path.join(__dirname, "mydial.db");

const DISPOSITIONS = {
  positive: { status: "positive", stage: "Interested", stayQueued: false },
  not_interested: { status: "not_interested", stage: "Closed", stayQueued: false },
  voicemail: { status: "voicemail", stage: "Follow-up", stayQueued: true },
  no_answer: { status: "no_answer", stage: "Retry", stayQueued: true },
  dnc: { status: "dnc", stage: "Do Not Call", stayQueued: false },
};

const STATUS_LABELS = {
  new: "New",
  no_answer: "No Answer",
  voicemail: "Left Voicemail",
  positive: "Connected - Positive",
  not_interested: "Connected - Not Interested",
  dnc: "Do Not Call",
};

fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
const db = new DatabaseSync(DATABASE_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

function transaction(fn) {
  return () => {
    db.exec("BEGIN");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw error;
    }
  };
}

db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scripts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS objections (
    id TEXT PRIMARY KEY,
    script_id TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    response TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    script_id TEXT REFERENCES scripts(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    company TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',
    stage TEXT NOT NULL DEFAULT 'New',
    attempts INTEGER NOT NULL DEFAULT 0,
    in_queue INTEGER NOT NULL DEFAULT 1,
    queue_order INTEGER NOT NULL,
    last_called_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS call_logs (
    id TEXT PRIMARY KEY,
    lead_id TEXT,
    lead_name TEXT NOT NULL,
    lead_phone TEXT NOT NULL,
    campaign_id TEXT,
    outcome TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    started_at TEXT,
    ended_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_leads_queue ON leads(in_queue, queue_order);
  CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
  CREATE INDEX IF NOT EXISTS idx_call_logs_ended ON call_logs(ended_at);
`);

function addColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumn("leads", "title", "TEXT NOT NULL DEFAULT ''");
addColumn("leads", "timezone", "TEXT NOT NULL DEFAULT ''");
addColumn("leads", "tags", "TEXT NOT NULL DEFAULT ''");
addColumn("leads", "next_attempt_at", "TEXT");
addColumn("leads", "archived", "INTEGER NOT NULL DEFAULT 0");
addColumn("leads", "flow_node_id", "TEXT NOT NULL DEFAULT ''");
addColumn("campaigns", "cadence_json", "TEXT NOT NULL DEFAULT ''");
addColumn("campaigns", "flow_json", "TEXT NOT NULL DEFAULT ''");
addColumn("scripts", "sections_json", "TEXT NOT NULL DEFAULT ''");

db.exec(`
  CREATE TABLE IF NOT EXISTS email_threads (
    id TEXT PRIMARY KEY,
    lead_id TEXT,
    subject TEXT NOT NULL DEFAULT '',
    trigger_key TEXT NOT NULL DEFAULT '',
    triggers_paused INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS emails (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES email_threads(id) ON DELETE CASCADE,
    lead_id TEXT,
    direction TEXT NOT NULL,
    status TEXT NOT NULL,
    from_email TEXT NOT NULL DEFAULT '',
    to_email TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    trigger_key TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    read_at TEXT,
    sent_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS snippets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_emails_thread ON emails(thread_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_email_threads_lead ON email_threads(lead_id, updated_at);

  CREATE TABLE IF NOT EXISTS webhooks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    secret TEXT NOT NULL DEFAULT '',
    events TEXT NOT NULL DEFAULT '[]',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    webhook_id TEXT NOT NULL,
    event TEXT NOT NULL,
    status TEXT NOT NULL,
    response_code INTEGER,
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_webhook_deliveries ON webhook_deliveries(webhook_id, created_at);
`);

function dropColumn(table, column) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
}

db.exec("DROP INDEX IF EXISTS idx_leads_external");
dropColumn("leads", "external_source");
dropColumn("leads", "external_id");
db.prepare("DELETE FROM meta WHERE key LIKE 'setting.bookware%'").run();
db.prepare("DELETE FROM webhook_deliveries WHERE event = 'ingest.bookware'").run();

const SERVER_STARTED = Date.now();

function defaultCadence() {
  return {
    autoAdvance: true,
    skipWeekends: true,
    windowStart: "09:00",
    windowEnd: "16:30",
    maxAttempts: 3,
    retryMinutes: 45,
    steps: [
      { id: "dial-1", type: "dial", label: "Power dial", day: 1, time: "09:30" },
      { id: "wait-1", type: "wait", hours: 4 },
      { id: "follow-1", type: "followup", subject: "Following up", body: "Hi {{first_name}}, I just tried you at {{company}}. Happy to send a short note if a call is easier later." },
    ],
  };
}

function defaultFlow() {
  return {
    nodes: [
      { id: "start", type: "start", position: { x: 40, y: 180 }, data: { label: "Lead enrolled" } },
      { id: "dial-1", type: "dial", position: { x: 300, y: 120 }, data: { label: "Power dial", maxAttempts: 3 } },
      { id: "wait-1", type: "wait", position: { x: 600, y: 20 }, data: { label: "Wait", hours: 4 } },
      { id: "email-1", type: "email", position: { x: 600, y: 300 }, data: { label: "Follow-up email", subject: "Following up", body: "Hi {{first_name}}, I tried you earlier about {{company}}.", autoSend: false } },
      { id: "end", type: "end", position: { x: 900, y: 180 }, data: { label: "Exit sequence" } },
    ],
    edges: [
      { id: "e-start", source: "start", target: "dial-1" },
      { id: "e-na", source: "dial-1", target: "wait-1", sourceHandle: "no_answer", label: "no_answer" },
      { id: "e-vm", source: "dial-1", target: "email-1", sourceHandle: "voicemail", label: "voicemail" },
      { id: "e-pos", source: "dial-1", target: "end", sourceHandle: "positive", label: "positive" },
      { id: "e-ni", source: "dial-1", target: "end", sourceHandle: "not_interested", label: "not_interested" },
      { id: "e-dnc", source: "dial-1", target: "end", sourceHandle: "dnc", label: "dnc" },
      { id: "e-max", source: "dial-1", target: "end", sourceHandle: "max", label: "max" },
      { id: "e-wait", source: "wait-1", target: "dial-1" },
      { id: "e-email", source: "email-1", target: "end" },
    ],
  };
}

function parseFlow(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.nodes) || !parsed.nodes.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseCadence(raw) {
  if (!raw) return defaultCadence();
  try {
    const parsed = JSON.parse(raw);
    return { ...defaultCadence(), ...parsed, steps: Array.isArray(parsed.steps) && parsed.steps.length ? parsed.steps : defaultCadence().steps };
  } catch {
    return defaultCadence();
  }
}

function parseSections(raw, body) {
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch { /* fall through */ }
  }
  return body ? [{ label: "Opening", text: body }] : [];
}

function nowIso() {
  return new Date().toISOString();
}

function normalizePhone(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `1${digits}`;
  return digits;
}

function durationSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.round(n), 86400);
}

function nextQueueOrder() {
  return db.prepare("SELECT COALESCE(MAX(queue_order), 0) + 1 AS n FROM leads").get().n;
}

function mapLead(row) {
  if (!row) return null;
  return {
    id: row.id,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name ?? null,
    name: row.name,
    phone: row.phone,
    company: row.company,
    email: row.email,
    notes: row.notes,
    title: row.title || "",
    timezone: row.timezone || "",
    tags: row.tags || "",
    status: row.status,
    stage: row.stage,
    attempts: row.attempts,
    inQueue: Boolean(row.in_queue),
    queueOrder: row.queue_order,
    nextAttemptAt: row.next_attempt_at || null,
    archived: Boolean(row.archived),
    flowNodeId: row.flow_node_id || "",
    lastCalledAt: row.last_called_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    score: scoreLead(row),
  };
}

function scoreLead(row) {
  const base = { new: 70, no_answer: 48, voicemail: 58, positive: 92, not_interested: 12, dnc: 0 }[row.status] ?? 40;
  const value = row.status === "positive" || row.status === "dnc"
    ? base
    : Math.max(0, base - Math.min((row.attempts || 0) * 4, 24));
  const band = value >= 85 ? "Priority" : value >= 65 ? "Warm" : value >= 40 ? "Nurture" : "Low";
  return { value, band };
}

const leadSelect = `
  SELECT leads.*, campaigns.name AS campaign_name, campaigns.status AS campaign_status, campaigns.cadence_json
  FROM leads
  LEFT JOIN campaigns ON campaigns.id = leads.campaign_id
`;

function getLead(id) {
  return mapLead(db.prepare(`${leadSelect} WHERE leads.id = ?`).get(id));
}

function mapScript(row) {
  const objections = db.prepare(
    "SELECT id, label, response, sort_order AS sortOrder FROM objections WHERE script_id = ? ORDER BY sort_order, label"
  ).all(row.id);
  const sections = parseSections(row.sections_json, row.body);
  return {
    id: row.id,
    name: row.name,
    body: row.body,
    sections,
    objections,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getScript(id) {
  const row = db.prepare("SELECT * FROM scripts WHERE id = ?").get(id);
  return row ? mapScript(row) : null;
}

function campaignStatsSql() {
  return `
    SELECT campaigns.*,
      scripts.name AS script_name,
      (SELECT COUNT(*) FROM leads WHERE leads.campaign_id = campaigns.id AND leads.archived = 0) AS lead_count,
      (SELECT COUNT(*) FROM leads WHERE leads.campaign_id = campaigns.id AND leads.in_queue = 1 AND leads.archived = 0) AS queued_count,
      (SELECT COUNT(*) FROM call_logs WHERE call_logs.campaign_id = campaigns.id) AS call_count,
      (SELECT COUNT(*) FROM call_logs WHERE call_logs.campaign_id = campaigns.id AND call_logs.outcome = 'positive') AS positive_count
    FROM campaigns
    LEFT JOIN scripts ON scripts.id = campaigns.script_id
  `;
}

function mapCampaign(row) {
  if (!row) return null;
  const calls = row.call_count ?? 0;
  const positive = row.positive_count ?? 0;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    scriptId: row.script_id,
    scriptName: row.script_name ?? null,
    leadCount: row.lead_count ?? 0,
    queuedCount: row.queued_count ?? 0,
    callCount: calls,
    positiveCount: positive,
    conversionRate: calls ? positive / calls : 0,
    cadence: parseCadence(row.cadence_json),
    flow: parseFlow(row.flow_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getCampaign(id) {
  return mapCampaign(db.prepare(`${campaignStatsSql()} WHERE campaigns.id = ?`).get(id));
}

function mapCall(row) {
  if (!row) return null;
  return {
    id: row.id,
    leadId: row.lead_id,
    leadName: row.lead_name,
    leadPhone: row.lead_phone,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name ?? null,
    outcome: row.outcome,
    durationSeconds: row.duration_seconds,
    notes: row.notes,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function scriptForCampaign(campaignId) {
  if (!campaignId) return null;
  const campaign = db.prepare("SELECT script_id FROM campaigns WHERE id = ?").get(campaignId);
  if (!campaign?.script_id) return null;
  return getScript(campaign.script_id);
}

function attachScript(lead) {
  if (!lead) return null;
  return { ...lead, script: scriptForCampaign(lead.campaignId), calls: recentCalls(lead.id) };
}

function recentCalls(leadId) {
  return db.prepare(`
    SELECT call_logs.*, campaigns.name AS campaign_name
    FROM call_logs
    LEFT JOIN campaigns ON campaigns.id = call_logs.campaign_id
    WHERE call_logs.lead_id = ?
    ORDER BY call_logs.ended_at DESC
    LIMIT 4
  `).all(leadId).map(mapCall);
}

function requireCampaign(id) {
  if (!id) return null;
  const row = db.prepare("SELECT id FROM campaigns WHERE id = ?").get(id);
  return row ? row.id : undefined;
}

function requireScript(id) {
  if (!id) return null;
  const row = db.prepare("SELECT id FROM scripts WHERE id = ?").get(id);
  return row ? row.id : undefined;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  const src = String(text ?? "").replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((value) => String(value).trim() !== ""));
}

function replaceObjections(scriptId, objections) {
  db.prepare("DELETE FROM objections WHERE script_id = ?").run(scriptId);
  const insert = db.prepare(
    "INSERT INTO objections (id, script_id, label, response, sort_order) VALUES (?, ?, ?, ?, ?)"
  );
  objections.forEach((item, index) => {
    const label = String(item?.label ?? "").trim();
    const response = String(item?.response ?? "").trim();
    if (!label || !response) return;
    insert.run(crypto.randomUUID(), scriptId, label, response, index);
  });
}

function insertCallLog({ lead, outcome, notes, duration, startedAt, endedAt }) {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO call_logs (
      id, lead_id, lead_name, lead_phone, campaign_id, outcome,
      duration_seconds, notes, started_at, ended_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    lead?.id ?? null,
    lead?.name ?? "Unknown",
    lead?.phone ?? "",
    lead?.campaignId ?? lead?.campaign_id ?? null,
    outcome,
    duration,
    notes,
    startedAt,
    endedAt,
  );
  return id;
}

function importJsonLeads() {
  const already = db.prepare("SELECT value FROM meta WHERE key = 'imported_json'").get();
  if (already) return;
  const file = path.join(__dirname, "db.json");
  if (!fs.existsSync(file)) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('imported_json', 'skipped')").run();
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    db.prepare("INSERT INTO meta (key, value) VALUES ('imported_json', 'invalid')").run();
    return;
  }
  const leads = Array.isArray(parsed?.leads) ? parsed.leads : [];
  const insertLead = db.prepare(`
    INSERT OR IGNORE INTO leads (
      id, campaign_id, name, phone, company, email, notes, status, stage,
      attempts, in_queue, queue_order, last_called_at, created_at, updated_at
    ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const importAll = transaction(() => {
    for (const lead of leads) {
      if (!lead?.id || !lead?.name || !lead?.phone) continue;
      insertLead.run(
        lead.id,
        lead.name,
        lead.phone,
        lead.company || "",
        lead.email || "",
        lead.notes || "",
        lead.status || "new",
        lead.stage || "New",
        lead.attempts || 0,
        lead.inQueue ? 1 : 0,
        lead.queueOrder || nextQueueOrder(),
        lead.lastCalledAt || null,
        lead.createdAt || nowIso(),
        lead.updatedAt || nowIso(),
      );
      for (const entry of lead.history || []) {
        insertCallLog({
          lead: { id: lead.id, name: lead.name, phone: lead.phone, campaignId: null },
          outcome: entry.outcome || "no_answer",
          notes: entry.notes || "",
          duration: 0,
          startedAt: entry.at || null,
          endedAt: entry.at || nowIso(),
        });
      }
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('imported_json', ?)").run(nowIso());
  });
  importAll();
}

importJsonLeads();

const app = express();
app.use("/api", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});
app.use(express.json({ limit: "2mb" }));
app.use(express.text({ type: ["text/csv", "text/plain"], limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));
const openapi = JSON.parse(fs.readFileSync(path.join(__dirname, "public", "openapi.json"), "utf8"));
app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: "MyDial API" }));

function minutesNow() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function parseClock(value, fallback) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  return Number(match[1]) * 60 + Number(match[2]);
}

function dueState(row) {
  const now = nowIso();
  if (row.next_attempt_at && row.next_attempt_at > now) {
    return { due: false, reason: "Retry backoff" };
  }
  if (!row.campaign_id) return { due: true, reason: null };
  const cadence = parseCadence(row.cadence_json);
  const day = new Date().getDay();
  if (cadence.skipWeekends && (day === 0 || day === 6)) {
    return { due: false, reason: "Weekend guardrail" };
  }
  const start = parseClock(cadence.windowStart, 0);
  const end = parseClock(cadence.windowEnd, 24 * 60);
  const minute = minutesNow();
  if (minute < start || minute > end) return { due: false, reason: "Outside calling window" };
  return { due: true, reason: null };
}

function queueRows(campaignId) {
  const params = [];
  let extra = "AND (campaigns.status IS NULL OR campaigns.status = 'active')";
  if (campaignId) {
    extra = "AND leads.campaign_id = ?";
    params.push(campaignId);
  }
  return db.prepare(`
    ${leadSelect}
    WHERE leads.in_queue = 1 AND leads.archived = 0 ${extra}
    ORDER BY leads.queue_order ASC
  `).all(...params);
}

app.get("/api/health", (_req, res) => {
  let bytes = 0;
  try { bytes = fs.statSync(DATABASE_PATH).size; } catch { /* missing until first write */ }
  res.json({
    ok: true,
    uptimeSeconds: Math.round((Date.now() - SERVER_STARTED) / 1000),
    node: process.version,
    port: Number(PORT),
    sqlite: { path: DATABASE_PATH, bytes, wal: true },
    googleVoicePrefix: "https://voice.google.com/u/0/calls?a=nc,%2B",
  });
});

const SECRET_SETTINGS = new Set(["smtpPass"]);

function readSettings() {
  const rows = db.prepare("SELECT key, value FROM meta WHERE key LIKE 'setting.%'").all();
  const settings = { gvLine: "", clipboardFallback: true, smtpConfigured: false };
  for (const row of rows) {
    const key = row.key.slice("setting.".length);
    if (SECRET_SETTINGS.has(key)) continue;
    settings[key] = row.value === "true" ? true : row.value === "false" ? false : row.value;
  }
  settings.smtpConfigured = Boolean(settings.smtpHost);
  return settings;
}

app.get("/api/settings", (_req, res) => {
  res.json(readSettings());
});

app.patch("/api/settings", (req, res) => {
  const put = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  for (const key of ["gvLine", "mailFromName", "mailFromEmail", "smtpHost", "smtpPort", "smtpUser"]) {
    if (req.body?.[key] !== undefined) put.run(`setting.${key}`, String(req.body[key]).trim());
  }
  if (req.body?.smtpPass) put.run("setting.smtpPass", String(req.body.smtpPass));
  if (req.body?.clipboardFallback !== undefined) put.run("setting.clipboardFallback", req.body.clipboardFallback ? "true" : "false");
  res.json(readSettings());
});

app.get("/api", (_req, res) => {
  res.json({
    name: "MyDial",
    endpoints: [
      "GET /api/stats",
      "GET /api/leads",
      "POST /api/leads",
      "POST /api/leads/import",
      "GET /api/leads/:id",
      "PATCH /api/leads/:id",
      "DELETE /api/leads/:id",
      "POST /api/leads/:id/dial",
      "POST /api/leads/:id/disposition",
      "POST /api/leads/:id/requeue",
      "GET /api/queue/next",
      "GET /api/campaigns",
      "POST /api/campaigns",
      "GET /api/campaigns/:id",
      "PATCH /api/campaigns/:id",
      "DELETE /api/campaigns/:id",
      "GET /api/scripts",
      "POST /api/scripts",
      "GET /api/scripts/:id",
      "PATCH /api/scripts/:id",
      "DELETE /api/scripts/:id",
      "GET /api/call-logs",
      "POST /api/call-logs",
      "POST /api/leads/:id/archive",
      "POST /api/leads/:id/reset-attempts",
      "GET /api/webhooks",
      "GET /api/docs",
    ],
  });
});

app.get("/api/stats", (_req, res) => {
  const byStatus = Object.fromEntries(
    db.prepare("SELECT status, COUNT(*) AS n FROM leads WHERE archived = 0 GROUP BY status").all().map((row) => [row.status, row.n])
  );
  const byOutcome = Object.fromEntries(
    db.prepare("SELECT outcome, COUNT(*) AS n FROM call_logs GROUP BY outcome").all().map((row) => [row.outcome, row.n])
  );
  const totalLeads = db.prepare("SELECT COUNT(*) AS n FROM leads WHERE archived = 0").get().n;
  const archived = db.prepare("SELECT COUNT(*) AS n FROM leads WHERE archived = 1").get().n;
  const inQueue = db.prepare("SELECT COUNT(*) AS n FROM leads WHERE in_queue = 1 AND archived = 0").get().n;
  const totalCalls = db.prepare("SELECT COUNT(*) AS n FROM call_logs").get().n;
  const today = nowIso().slice(0, 10);
  const callsToday = db.prepare("SELECT COUNT(*) AS n FROM call_logs WHERE ended_at LIKE ?").get(`${today}%`).n;
  const positive = byOutcome.positive || 0;
  const connected = (byOutcome.positive || 0) + (byOutcome.not_interested || 0);
  const avgDuration = db.prepare("SELECT AVG(duration_seconds) AS n FROM call_logs").get().n || 0;
  const campaigns = db.prepare(`${campaignStatsSql()} ORDER BY campaigns.created_at DESC`).all().map(mapCampaign);
  const unreadMail = db.prepare("SELECT COUNT(*) AS n FROM emails WHERE direction = 'inbound' AND read_at IS NULL").get().n;
  const draftMail = db.prepare("SELECT COUNT(*) AS n FROM emails WHERE status = 'draft'").get().n;

  res.json({
    leads: { total: totalLeads, inQueue, archived, byStatus },
    calls: { total: totalCalls, today: callsToday, byOutcome, averageDurationSeconds: Math.round(avgDuration) },
    conversionRate: totalCalls ? positive / totalCalls : 0,
    connectRate: totalCalls ? connected / totalCalls : 0,
    campaigns,
    inbox: { unread: unreadMail, drafts: draftMail },
  });
});

app.get("/api/leads", (req, res) => {
  const where = [];
  const params = [];
  if (req.query.status) {
    where.push("leads.status = ?");
    params.push(String(req.query.status));
  }
  if (req.query.campaignId) {
    where.push("leads.campaign_id = ?");
    params.push(String(req.query.campaignId));
  }
  if (req.query.search) {
    where.push("(leads.name LIKE ? OR leads.phone LIKE ? OR leads.company LIKE ? OR leads.email LIKE ? OR leads.title LIKE ? OR leads.tags LIKE ?)");
    const like = `%${String(req.query.search).trim()}%`;
    params.push(like, like, like, like, like, like);
  }
  where.push(req.query.archived === "1" ? "leads.archived = 1" : "leads.archived = 0");
  const sql = `${leadSelect} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY leads.queue_order ASC`;
  res.json(db.prepare(sql).all(...params).map(mapLead));
});

app.get("/api/queue/next", (req, res) => {
  releaseDueWaits();
  const rows = queueRows(req.query.campaignId ? String(req.query.campaignId) : "");
  const ready = [];
  const reasons = {};
  for (const row of rows) {
    const state = dueState(row);
    if (state.due) ready.push(row);
    else reasons[state.reason] = (reasons[state.reason] || 0) + 1;
  }
  const current = ready[0] ? attachScript(mapLead(ready[0])) : null;
  const upcoming = ready[1] ? mapLead(ready[1]) : null;
  res.json({
    lead: current,
    upcoming,
    ready: ready.length,
    waiting: rows.length - ready.length,
    reasons,
  });
});

app.get("/api/leads/export", (req, res) => {
  const where = [];
  const params = [];
  if (req.query.status) {
    where.push("leads.status = ?");
    params.push(String(req.query.status));
  }
  if (req.query.campaignId) {
    where.push("leads.campaign_id = ?");
    params.push(String(req.query.campaignId));
  }
  if (req.query.search) {
    const like = `%${String(req.query.search).trim()}%`;
    where.push("(leads.name LIKE ? OR leads.phone LIKE ? OR leads.company LIKE ? OR leads.email LIKE ? OR leads.title LIKE ?)");
    params.push(like, like, like, like, like);
  }
  where.push(req.query.archived === "1" ? "leads.archived = 1" : "leads.archived = 0");
  const rows = db.prepare(`${leadSelect} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY leads.name COLLATE NOCASE`).all(...params);
  const header = ["name", "title", "phone", "company", "email", "status", "stage", "attempts", "tags", "notes"];
  const lines = [header.join(",")];
  for (const row of rows) {
    const values = [row.name, row.title, row.phone, row.company, row.email, row.status, row.stage, row.attempts, row.tags, row.notes];
    lines.push(values.map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(","));
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=\"leads.csv\"");
  res.send(lines.join("\n"));
});

app.post("/api/leads/enqueue", (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  if (!ids.length) {
    res.status(400).json({ error: "Choose at least one lead." });
    return;
  }
  const update = db.prepare("UPDATE leads SET in_queue = 1, queue_order = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ? AND status != 'dnc' AND archived = 0");
  let queued = 0;
  const run = transaction(() => {
    for (const id of ids) {
      const result = update.run(nextQueueOrder(), nowIso(), id);
      queued += result.changes || 0;
    }
  });
  run();
  res.json({ queued });
});

app.post("/api/leads/import", (req, res) => {
  const csv = typeof req.body === "string" ? req.body : String(req.body?.csv ?? "");
  const requestedCampaign = typeof req.body === "string"
    ? req.query.campaignId
    : (req.body?.campaignId || req.query.campaignId);
  const campaignId = requireCampaign(requestedCampaign || null);
  if (campaignId === undefined) {
    res.status(400).json({ error: "Campaign not found." });
    return;
  }
  const table = parseCsv(csv);
  if (table.length < 2) {
    res.status(400).json({ error: "CSV needs a header row and at least one lead." });
    return;
  }
  const headers = table[0].map((header) => header.trim().toLowerCase());
  const indexOf = (...names) => names.map((name) => headers.indexOf(name)).find((index) => index >= 0) ?? -1;
  const nameIndex = indexOf("name", "full name");
  const phoneIndex = indexOf("phone", "phone number", "mobile");
  if (nameIndex < 0 || phoneIndex < 0) {
    res.status(400).json({ error: "CSV must include name and phone columns." });
    return;
  }
  const companyIndex = indexOf("company", "organization");
  const emailIndex = indexOf("email");
  const notesIndex = indexOf("notes", "note");
  const titleIndex = indexOf("title");
  const timezoneIndex = indexOf("timezone", "time zone");
  const tagsIndex = indexOf("tags", "tag");

  const created = [];
  const errors = [];
  const insert = db.prepare(`
    INSERT INTO leads (
      id, campaign_id, name, phone, company, email, notes, title, timezone, tags, status, stage,
      attempts, in_queue, queue_order, last_called_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 'New', 0, 1, ?, NULL, ?, ?)
  `);

  const run = transaction(() => {
    table.slice(1).forEach((columns, offset) => {
      const name = String(columns[nameIndex] ?? "").trim();
      const phone = normalizePhone(columns[phoneIndex]);
      if (!name || phone.length < 10) {
        errors.push({ row: offset + 2, error: "Name and a valid phone are required." });
        return;
      }
      const timestamp = nowIso();
      const id = crypto.randomUUID();
      insert.run(
        id,
        campaignId,
        name,
        phone,
        companyIndex >= 0 ? String(columns[companyIndex] ?? "").trim() : "",
        emailIndex >= 0 ? String(columns[emailIndex] ?? "").trim() : "",
        notesIndex >= 0 ? String(columns[notesIndex] ?? "") : "",
        titleIndex >= 0 ? String(columns[titleIndex] ?? "").trim() : "",
        timezoneIndex >= 0 ? String(columns[timezoneIndex] ?? "").trim() : "",
        tagsIndex >= 0 ? String(columns[tagsIndex] ?? "").trim() : "",
        nextQueueOrder(),
        timestamp,
        timestamp,
      );
      created.push(id);
    });
  });
  run();
  res.status(201).json({
    created: created.length,
    skipped: errors.length,
    errors,
    leads: created.map((id) => getLead(id)),
  });
});

app.post("/api/leads", (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const phone = normalizePhone(req.body?.phone);
  if (!name || !phone) {
    res.status(400).json({ error: "Name and phone are required." });
    return;
  }
  if (phone.length < 10) {
    res.status(400).json({ error: "Enter a valid phone number." });
    return;
  }
  const campaignId = requireCampaign(req.body?.campaignId || null);
  if (campaignId === undefined) {
    res.status(400).json({ error: "Campaign not found." });
    return;
  }
  const timestamp = nowIso();
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO leads (
      id, campaign_id, name, phone, company, email, notes, title, timezone, tags, status, stage,
      attempts, in_queue, queue_order, last_called_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 'New', 0, 1, ?, NULL, ?, ?)
  `).run(
    id,
    campaignId,
    name,
    phone,
    String(req.body?.company ?? "").trim(),
    String(req.body?.email ?? "").trim(),
    String(req.body?.notes ?? ""),
    String(req.body?.title ?? "").trim(),
    String(req.body?.timezone ?? "").trim(),
    String(req.body?.tags ?? "").trim(),
    nextQueueOrder(),
    timestamp,
    timestamp,
  );
  enrollLead(id);
  const created = getLead(id);
  emitWebhook("lead.created", leadSnapshot(created));
  res.status(201).json(created);
});

app.get("/api/leads/:id", (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) {
    res.status(404).json({ error: "Lead not found." });
    return;
  }
  const calls = db.prepare(`
    SELECT call_logs.*, campaigns.name AS campaign_name
    FROM call_logs
    LEFT JOIN campaigns ON campaigns.id = call_logs.campaign_id
    WHERE call_logs.lead_id = ?
    ORDER BY call_logs.ended_at DESC
  `).all(lead.id).map(mapCall);
  res.json({ ...lead, calls, script: scriptForCampaign(lead.campaignId) });
});

app.patch("/api/leads/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: "Lead not found." });
    return;
  }
  const body = req.body ?? {};
  const name = body.name !== undefined ? String(body.name).trim() : existing.name;
  if (!name) {
    res.status(400).json({ error: "Name cannot be empty." });
    return;
  }
  let phone = existing.phone;
  if (body.phone !== undefined) {
    phone = normalizePhone(body.phone);
    if (phone.length < 10) {
      res.status(400).json({ error: "Enter a valid phone number." });
      return;
    }
  }
  let campaignId = existing.campaign_id;
  if (body.campaignId !== undefined) {
    campaignId = requireCampaign(body.campaignId || null);
    if (campaignId === undefined) {
      res.status(400).json({ error: "Campaign not found." });
      return;
    }
  }
  let status = existing.status;
  let stage = existing.stage;
  let inQueue = existing.in_queue;
  if (body.status !== undefined) {
    const rule = DISPOSITIONS[body.status] || (body.status === "new"
      ? { status: "new", stage: "New", stayQueued: true }
      : null);
    if (!rule) {
      res.status(400).json({ error: "Unknown status." });
      return;
    }
    status = rule.status;
    stage = rule.stage;
    inQueue = rule.stayQueued ? 1 : 0;
  }
  db.prepare(`
    UPDATE leads SET
      name = ?, phone = ?, company = ?, email = ?, notes = ?, title = ?, timezone = ?, tags = ?,
      campaign_id = ?, status = ?, stage = ?, in_queue = ?, updated_at = ?
    WHERE id = ?
  `).run(
    name,
    phone,
    body.company !== undefined ? String(body.company).trim() : existing.company,
    body.email !== undefined ? String(body.email).trim() : existing.email,
    body.notes !== undefined ? String(body.notes) : existing.notes,
    body.title !== undefined ? String(body.title).trim() : (existing.title || ""),
    body.timezone !== undefined ? String(body.timezone).trim() : (existing.timezone || ""),
    body.tags !== undefined ? String(body.tags).trim() : (existing.tags || ""),
    campaignId,
    status,
    stage,
    inQueue,
    nowIso(),
    existing.id,
  );
  if (campaignId && campaignId !== existing.campaign_id) {
    db.prepare("UPDATE leads SET flow_node_id = '' WHERE id = ?").run(existing.id);
    enrollLead(existing.id);
  }
  const updated = getLead(existing.id);
  emitWebhook("lead.updated", leadSnapshot(updated));
  res.json(updated);
});

app.delete("/api/leads/:id", (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) {
    res.status(404).json({ error: "Lead not found." });
    return;
  }
  db.prepare("DELETE FROM email_threads WHERE lead_id = ?").run(lead.id);
  db.prepare("DELETE FROM leads WHERE id = ?").run(lead.id);
  res.json(lead);
});

app.post("/api/leads/:id/dial", (req, res) => {
  const existing = db.prepare("SELECT id FROM leads WHERE id = ?").get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: "Lead not found." });
    return;
  }
  const timestamp = nowIso();
  db.prepare("UPDATE leads SET attempts = attempts + 1, last_called_at = ?, updated_at = ? WHERE id = ?")
    .run(timestamp, timestamp, existing.id);
  const dialed = getLead(existing.id);
  emitWebhook("lead.dialed", leadSnapshot(dialed));
  res.json(dialed);
});

app.post("/api/leads/:id/disposition", (req, res) => {
  const existing = getLead(req.params.id);
  if (!existing) {
    res.status(404).json({ error: "Lead not found." });
    return;
  }
  const outcome = req.body?.outcome;
  const rule = DISPOSITIONS[outcome];
  if (!rule) {
    res.status(400).json({ error: "Unknown disposition." });
    return;
  }
  const notes = req.body?.notes !== undefined ? String(req.body.notes) : existing.notes;
  const duration = durationSeconds(req.body?.durationSeconds);
  const endedAt = nowIso();
  const startedAt = req.body?.startedAt || new Date(Date.now() - duration * 1000).toISOString();
  const campaignRow = existing.campaignId
    ? db.prepare("SELECT cadence_json, flow_json FROM campaigns WHERE id = ?").get(existing.campaignId)
    : null;
  const cadence = campaignRow ? parseCadence(campaignRow.cadence_json) : null;
  const flow = campaignRow ? parseFlow(campaignRow.flow_json) : null;
  let inQueue = rule.stayQueued ? 1 : 0;
  let nextAttemptAt = null;
  if (flow) {
    inQueue = existing.inQueue ? 1 : 0;
    nextAttemptAt = existing.nextAttemptAt;
  } else if (rule.stayQueued && cadence && existing.attempts >= Number(cadence.maxAttempts || 3)) {
    inQueue = 0;
  } else if (rule.stayQueued && cadence) {
    nextAttemptAt = new Date(Date.now() + Number(cadence.retryMinutes || 45) * 60000).toISOString();
  }

  const save = transaction(() => {
    db.prepare(`
      UPDATE leads SET
        notes = ?, status = ?, stage = ?, in_queue = ?, queue_order = ?, next_attempt_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      notes,
      rule.status,
      rule.stage,
      inQueue,
      inQueue ? nextQueueOrder() : existing.queueOrder,
      nextAttemptAt,
      endedAt,
      existing.id,
    );
    insertCallLog({
      lead: { ...existing, name: existing.name },
      outcome,
      notes,
      duration,
      startedAt,
      endedAt,
    });
  });
  save();
  if (flow) advanceFromDial(existing.id, outcome, existing.attempts);
  if (outcome === "dnc" || outcome === "not_interested") {
    db.prepare("UPDATE email_threads SET triggers_paused = 1, updated_at = ? WHERE lead_id = ?").run(nowIso(), existing.id);
  }
  const followupDraft = flow ? false : queueFollowupDraft(existing, outcome);
  const updated = getLead(existing.id);
  emitWebhook("lead.disposition", { ...leadSnapshot(updated), outcome, durationSeconds: duration });
  res.json({ ...updated, followupDraft });
});

app.post("/api/leads/:id/requeue", (req, res) => {
  const existing = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: "Lead not found." });
    return;
  }
  if (existing.status === "dnc") {
    res.status(400).json({ error: "Do Not Call leads cannot be re-queued." });
    return;
  }
  if (existing.archived) {
    res.status(400).json({ error: "Restore this lead before re-queuing it." });
    return;
  }
  db.prepare("UPDATE leads SET in_queue = 1, queue_order = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ?")
    .run(nextQueueOrder(), nowIso(), existing.id);
  res.json(getLead(existing.id));
});

app.post("/api/leads/:id/skip", (req, res) => {
  const existing = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: "Lead not found." });
    return;
  }
  db.prepare("UPDATE leads SET queue_order = ?, updated_at = ? WHERE id = ?")
    .run(nextQueueOrder(), nowIso(), existing.id);
  res.json(getLead(existing.id));
});

app.get("/api/campaigns", (_req, res) => {
  res.json(db.prepare(`${campaignStatsSql()} ORDER BY campaigns.created_at DESC`).all().map(mapCampaign));
});

app.post("/api/campaigns", (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "Campaign name is required." });
    return;
  }
  const status = ["active", "paused", "completed"].includes(req.body?.status) ? req.body.status : "active";
  const scriptId = requireScript(req.body?.scriptId || null);
  if (scriptId === undefined) {
    res.status(400).json({ error: "Script not found." });
    return;
  }
  const timestamp = nowIso();
  const id = crypto.randomUUID();
  const cadence = JSON.stringify(req.body?.cadence ? { ...defaultCadence(), ...req.body.cadence } : defaultCadence());
  const flow = JSON.stringify(req.body?.flow ? (normalizeFlow(req.body.flow) || defaultFlow()) : defaultFlow());
  db.prepare(`
    INSERT INTO campaigns (id, name, description, status, script_id, cadence_json, flow_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, String(req.body?.description ?? "").trim(), status, scriptId, cadence, flow, timestamp, timestamp);
  res.status(201).json(getCampaign(id));
});

app.get("/api/campaigns/:id", (req, res) => {
  const campaign = getCampaign(req.params.id);
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found." });
    return;
  }
  res.json({ ...campaign, script: scriptForCampaign(campaign.id) });
});

app.patch("/api/campaigns/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: "Campaign not found." });
    return;
  }
  const name = req.body?.name !== undefined ? String(req.body.name).trim() : existing.name;
  if (!name) {
    res.status(400).json({ error: "Campaign name is required." });
    return;
  }
  let status = existing.status;
  if (req.body?.status !== undefined) {
    if (!["active", "paused", "completed"].includes(req.body.status)) {
      res.status(400).json({ error: "Status must be active, paused, or completed." });
      return;
    }
    status = req.body.status;
  }
  let scriptId = existing.script_id;
  if (req.body?.scriptId !== undefined) {
    scriptId = requireScript(req.body.scriptId || null);
    if (scriptId === undefined) {
      res.status(400).json({ error: "Script not found." });
      return;
    }
  }
  const cadence = req.body?.cadence
    ? JSON.stringify({ ...parseCadence(existing.cadence_json), ...req.body.cadence, steps: req.body.cadence.steps || parseCadence(existing.cadence_json).steps })
    : existing.cadence_json;
  let flowJson = existing.flow_json || "";
  if (req.body?.flow !== undefined) {
    const normalized = normalizeFlow(req.body.flow);
    if (!normalized) {
      res.status(400).json({ error: "A flow needs at least one node." });
      return;
    }
    flowJson = JSON.stringify(normalized);
  }
  db.prepare(`
    UPDATE campaigns SET name = ?, description = ?, status = ?, script_id = ?, cadence_json = ?, flow_json = ?, updated_at = ? WHERE id = ?
  `).run(
    name,
    req.body?.description !== undefined ? String(req.body.description).trim() : existing.description,
    status,
    scriptId,
    cadence,
    flowJson,
    nowIso(),
    existing.id,
  );
  res.json(getCampaign(existing.id));
});

app.delete("/api/campaigns/:id", (req, res) => {
  const campaign = getCampaign(req.params.id);
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found." });
    return;
  }
  db.prepare("DELETE FROM campaigns WHERE id = ?").run(campaign.id);
  res.json(campaign);
});

app.get("/api/scripts", (_req, res) => {
  res.json(db.prepare("SELECT * FROM scripts ORDER BY updated_at DESC").all().map(mapScript));
});

app.post("/api/scripts", (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "Script name is required." });
    return;
  }
  const timestamp = nowIso();
  const id = crypto.randomUUID();
  const save = transaction(() => {
    const sections = Array.isArray(req.body?.sections) ? req.body.sections : [];
    const body = sections.length
      ? sections.map((section) => String(section.text || "")).filter(Boolean).join("\n\n")
      : String(req.body?.body ?? "");
    db.prepare("INSERT INTO scripts (id, name, body, sections_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, name, body, JSON.stringify(sections), timestamp, timestamp);
    replaceObjections(id, Array.isArray(req.body?.objections) ? req.body.objections : []);
  });
  save();
  res.status(201).json(getScript(id));
});

app.get("/api/scripts/:id", (req, res) => {
  const script = getScript(req.params.id);
  if (!script) {
    res.status(404).json({ error: "Script not found." });
    return;
  }
  res.json(script);
});

app.patch("/api/scripts/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM scripts WHERE id = ?").get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: "Script not found." });
    return;
  }
  const name = req.body?.name !== undefined ? String(req.body.name).trim() : existing.name;
  if (!name) {
    res.status(400).json({ error: "Script name is required." });
    return;
  }
  const save = transaction(() => {
    const sections = Array.isArray(req.body?.sections) ? req.body.sections : parseSections(existing.sections_json, existing.body);
    const body = Array.isArray(req.body?.sections)
      ? sections.map((section) => String(section.text || "")).filter(Boolean).join("\n\n")
      : (req.body?.body !== undefined ? String(req.body.body) : existing.body);
    db.prepare("UPDATE scripts SET name = ?, body = ?, sections_json = ?, updated_at = ? WHERE id = ?").run(
      name,
      body,
      JSON.stringify(sections),
      nowIso(),
      existing.id,
    );
    if (Array.isArray(req.body?.objections)) replaceObjections(existing.id, req.body.objections);
  });
  save();
  res.json(getScript(existing.id));
});

app.delete("/api/scripts/:id", (req, res) => {
  const script = getScript(req.params.id);
  if (!script) {
    res.status(404).json({ error: "Script not found." });
    return;
  }
  db.prepare("DELETE FROM scripts WHERE id = ?").run(script.id);
  res.json(script);
});

app.get("/api/call-logs", (req, res) => {
  const where = [];
  const params = [];
  if (req.query.leadId) {
    where.push("call_logs.lead_id = ?");
    params.push(String(req.query.leadId));
  }
  if (req.query.campaignId) {
    where.push("call_logs.campaign_id = ?");
    params.push(String(req.query.campaignId));
  }
  if (req.query.outcome) {
    where.push("call_logs.outcome = ?");
    params.push(String(req.query.outcome));
  }
  const sql = `
    SELECT call_logs.*, campaigns.name AS campaign_name
    FROM call_logs
    LEFT JOIN campaigns ON campaigns.id = call_logs.campaign_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY call_logs.ended_at DESC
  `;
  res.json(db.prepare(sql).all(...params).map(mapCall));
});

app.post("/api/call-logs", (req, res) => {
  const outcome = req.body?.outcome;
  if (!outcome || !STATUS_LABELS[outcome] && outcome !== "dialed") {
    res.status(400).json({ error: "A known outcome is required." });
    return;
  }
  const lead = req.body?.leadId ? getLead(req.body.leadId) : null;
  if (req.body?.leadId && !lead) {
    res.status(404).json({ error: "Lead not found." });
    return;
  }
  let manualCampaignId = null;
  if (!lead && req.body?.campaignId) {
    manualCampaignId = requireCampaign(req.body.campaignId);
    if (manualCampaignId === undefined) {
      res.status(400).json({ error: "Campaign not found." });
      return;
    }
  }
  const endedAt = nowIso();
  const duration = durationSeconds(req.body?.durationSeconds);
  const startedAt = req.body?.startedAt || new Date(Date.now() - duration * 1000).toISOString();
  const notes = String(req.body?.notes ?? "");
  const record = lead || {
    id: null,
    name: String(req.body?.leadName ?? "Unknown").trim() || "Unknown",
    phone: normalizePhone(req.body?.leadPhone),
    campaignId: manualCampaignId,
  };
  const id = insertCallLog({ lead: record, outcome, notes, duration, startedAt, endedAt });
  const row = db.prepare(`
    SELECT call_logs.*, campaigns.name AS campaign_name
    FROM call_logs
    LEFT JOIN campaigns ON campaigns.id = call_logs.campaign_id
    WHERE call_logs.id = ?
  `).get(id);
  res.status(201).json(mapCall(row));
});

function settingValue(key) {
  return db.prepare("SELECT value FROM meta WHERE key = ?").get(`setting.${key}`)?.value || "";
}

function mailIdentity() {
  const address = settingValue("mailFromEmail");
  const name = settingValue("mailFromName");
  return {
    address,
    name,
    header: address ? (name ? `${name} <${address}>` : address) : "",
  };
}

function fillMail(text, lead) {
  const first = String(lead?.name || "").trim().split(/\s+/)[0] || "there";
  return String(text || "")
    .replaceAll("{{first_name}}", first)
    .replaceAll("{{name}}", lead?.name || "")
    .replaceAll("{{company}}", lead?.company || "your team");
}

function defaultFollowup(outcome, lead) {
  const step = lead?.campaignId ? getCampaign(lead.campaignId)?.cadence?.steps?.find((item) => item.type === "followup") : null;
  const subject = fillMail(step?.subject || "Following up", lead);
  const body = fillMail(step?.body || (outcome === "voicemail"
    ? "Hi {{first_name}}, I just left a short message for {{company}}. Happy to try again, or I can send the note here."
    : "Hi {{first_name}}, I tried you earlier about {{company}}. If a call is easier later, tell me a time that works."), lead);
  return { subject, body };
}

function queueFollowupDraft(lead, outcome) {
  if (!lead?.id) return false;
  if (outcome === "dnc" || outcome === "not_interested") {
    db.prepare("UPDATE email_threads SET triggers_paused = 1, updated_at = ? WHERE lead_id = ?").run(nowIso(), lead.id);
    return false;
  }
  if (!["voicemail", "no_answer"].includes(outcome) || !lead.email) return false;
  const paused = db.prepare("SELECT id FROM email_threads WHERE lead_id = ? AND triggers_paused = 1").get(lead.id);
  if (paused) return false;
  const existing = db.prepare(`
    SELECT emails.id FROM emails
    JOIN email_threads ON email_threads.id = emails.thread_id
    WHERE emails.lead_id = ? AND emails.trigger_key = ? AND emails.status = 'draft'
  `).get(lead.id, outcome);
  if (existing) return false;
  const copy = defaultFollowup(outcome, lead);
  const identity = mailIdentity();
  const now = nowIso();
  const threadId = crypto.randomUUID();
  const emailId = crypto.randomUUID();
  const save = transaction(() => {
    db.prepare(`
      INSERT INTO email_threads (id, lead_id, subject, trigger_key, triggers_paused, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, ?, ?)
    `).run(threadId, lead.id, copy.subject, outcome, now, now);
    db.prepare(`
      INSERT INTO emails (
        id, thread_id, lead_id, direction, status, from_email, to_email, subject, body, trigger_key, created_at
      ) VALUES (?, ?, ?, 'outbound', 'draft', ?, ?, ?, ?, ?, ?)
    `).run(emailId, threadId, lead.id, identity.address, lead.email, copy.subject, copy.body, outcome, now);
  });
  save();
  return true;
}

function mapEmail(row) {
  return {
    id: row.id,
    threadId: row.thread_id,
    leadId: row.lead_id,
    direction: row.direction,
    status: row.status,
    fromEmail: row.from_email,
    toEmail: row.to_email,
    subject: row.subject,
    body: row.body,
    triggerKey: row.trigger_key || "",
    error: row.error || "",
    readAt: row.read_at,
    sentAt: row.sent_at,
    createdAt: row.created_at,
  };
}

const threadSelect = `
  SELECT t.*,
    leads.name AS lead_name,
    leads.company AS company,
    leads.title AS title,
    leads.phone AS phone,
    leads.email AS lead_email,
    (SELECT body FROM emails e WHERE e.thread_id = t.id ORDER BY e.created_at DESC LIMIT 1) AS preview,
    (SELECT status FROM emails e WHERE e.thread_id = t.id ORDER BY e.created_at DESC LIMIT 1) AS latest_status,
    (SELECT direction FROM emails e WHERE e.thread_id = t.id ORDER BY e.created_at DESC LIMIT 1) AS latest_direction,
    (SELECT COUNT(*) FROM emails e WHERE e.thread_id = t.id AND e.direction = 'inbound' AND e.read_at IS NULL) AS unread
  FROM email_threads t
  LEFT JOIN leads ON leads.id = t.lead_id
`;

function mapThread(row) {
  if (!row) return null;
  return {
    id: row.id,
    leadId: row.lead_id,
    leadName: row.lead_name || "",
    company: row.company || "",
    title: row.title || "",
    phone: row.phone || "",
    email: row.lead_email || "",
    subject: row.subject,
    preview: String(row.preview || "").replace(/\s+/g, " ").slice(0, 180),
    latestStatus: row.latest_status,
    latestDirection: row.latest_direction,
    triggerKey: row.trigger_key || "",
    triggersPaused: Boolean(row.triggers_paused),
    unread: row.unread || 0,
    updatedAt: row.updated_at,
  };
}

function inboxSummary() {
  const unread = db.prepare("SELECT COUNT(*) AS n FROM emails WHERE direction = 'inbound' AND read_at IS NULL").get().n;
  const threads = db.prepare("SELECT COUNT(*) AS n FROM email_threads").get().n;
  const drafts = db.prepare("SELECT COUNT(*) AS n FROM emails WHERE status = 'draft'").get().n;
  const needsReply = db.prepare(`
    SELECT COUNT(*) AS n FROM email_threads t
    WHERE (SELECT direction FROM emails e WHERE e.thread_id = t.id ORDER BY e.created_at DESC LIMIT 1) = 'inbound'
  `).get().n;
  const sentThreads = db.prepare("SELECT COUNT(DISTINCT thread_id) AS n FROM emails WHERE status IN ('sent', 'local')").get().n;
  const replied = db.prepare(`
    SELECT COUNT(DISTINCT thread_id) AS n FROM emails
    WHERE direction = 'inbound'
      AND thread_id IN (SELECT thread_id FROM emails WHERE status IN ('sent', 'local'))
  `).get().n;
  const countTrigger = (key) => db.prepare("SELECT COUNT(*) AS n FROM email_threads WHERE trigger_key = ? AND triggers_paused = 0").get(key).n;
  return {
    unread,
    threads,
    drafts,
    needsReply,
    sent: db.prepare("SELECT COUNT(*) AS n FROM emails WHERE status IN ('sent', 'local')").get().n,
    replyRate: sentThreads ? replied / sentThreads : 0,
    triggers: {
      no_answer: countTrigger("no_answer"),
      voicemail: countTrigger("voicemail"),
      idle: countTrigger("idle"),
      active: db.prepare("SELECT COUNT(*) AS n FROM email_threads WHERE trigger_key != '' AND triggers_paused = 0").get().n,
    },
    paused: db.prepare("SELECT COUNT(*) AS n FROM email_threads WHERE triggers_paused = 1").get().n,
    smtpConfigured: Boolean(settingValue("smtpHost")),
    fromEmail: settingValue("mailFromEmail"),
  };
}

function folderSql(folder) {
  const allowed = {
    needs_reply: `AND (SELECT direction FROM emails e WHERE e.thread_id = t.id ORDER BY e.created_at DESC LIMIT 1) = 'inbound'`,
    triggers: `AND t.trigger_key != '' AND t.triggers_paused = 0`,
    no_answer: `AND t.trigger_key = 'no_answer'`,
    voicemail: `AND t.trigger_key = 'voicemail'`,
    idle: `AND t.trigger_key = 'idle'`,
    demo: `AND t.trigger_key = 'demo'`,
    sent: `AND EXISTS (SELECT 1 FROM emails e WHERE e.thread_id = t.id AND e.status IN ('sent', 'local'))`,
    drafts: `AND EXISTS (SELECT 1 FROM emails e WHERE e.thread_id = t.id AND e.status = 'draft')`,
    paused: `AND t.triggers_paused = 1`,
  };
  return allowed[folder] || "";
}

function idleSuggestions() {
  const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare(`
    SELECT leads.* FROM leads
    WHERE leads.email != ''
      AND leads.status NOT IN ('dnc', 'not_interested')
      AND COALESCE(leads.last_called_at, leads.created_at) < ?
      AND NOT EXISTS (
        SELECT 1 FROM email_threads
        WHERE email_threads.lead_id = leads.id AND email_threads.trigger_key = 'idle' AND email_threads.triggers_paused = 0
      )
    ORDER BY COALESCE(leads.last_called_at, leads.created_at) ASC
    LIMIT 50
  `).all(cutoff).map((row) => ({
    leadId: row.id,
    name: row.name,
    company: row.company,
    email: row.email,
    lastCalledAt: row.last_called_at,
  }));
}

function getThreadDetail(id, { markRead = false } = {}) {
  const row = db.prepare(`${threadSelect} WHERE t.id = ?`).get(id);
  if (!row) return null;
  if (markRead) {
    db.prepare("UPDATE emails SET read_at = ? WHERE thread_id = ? AND direction = 'inbound' AND read_at IS NULL").run(nowIso(), id);
  }
  const messages = db.prepare("SELECT * FROM emails WHERE thread_id = ? ORDER BY created_at ASC").all(id).map(mapEmail);
  const lead = row.lead_id ? getLead(row.lead_id) : null;
  const calls = row.lead_id ? db.prepare(`
    SELECT call_logs.*, campaigns.name AS campaign_name
    FROM call_logs
    LEFT JOIN campaigns ON campaigns.id = call_logs.campaign_id
    WHERE call_logs.lead_id = ?
    ORDER BY call_logs.ended_at DESC
    LIMIT 12
  `).all(row.lead_id).map(mapCall) : [];
  const journey = [
    ...calls.map((call) => ({ kind: "call", at: call.endedAt, outcome: call.outcome, notes: call.notes, durationSeconds: call.durationSeconds })),
    ...messages.map((message) => ({ kind: "email", at: message.sentAt || message.createdAt, direction: message.direction, status: message.status, subject: message.subject, triggerKey: message.triggerKey })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { thread: mapThread(db.prepare(`${threadSelect} WHERE t.id = ?`).get(id)), messages, lead, journey };
}

async function deliverEmail(emailId) {
  const email = db.prepare("SELECT * FROM emails WHERE id = ?").get(emailId);
  if (!email) throw new Error("Message not found.");
  if (!email.to_email) {
    db.prepare("UPDATE emails SET status = 'draft' WHERE id = ?").run(emailId);
    throw new Error("This message needs a recipient.");
  }
  const now = nowIso();
  const smtpHost = settingValue("smtpHost");
  if (!smtpHost) {
    db.prepare("UPDATE emails SET status = 'local', sent_at = ?, error = '' WHERE id = ?").run(now, emailId);
    db.prepare("UPDATE email_threads SET updated_at = ?, subject = ? WHERE id = ?").run(now, email.subject, email.thread_id);
    return { delivered: false, status: "local" };
  }
  const identity = mailIdentity();
  if (!identity.address) throw new Error("Add a from address before sending through SMTP.");
  const port = Number(settingValue("smtpPort") || 587);
  const user = settingValue("smtpUser");
  const pass = settingValue("smtpPass");
  const transport = nodemailer.createTransport({
    host: smtpHost,
    port,
    secure: port === 465,
    auth: user ? { user, pass } : undefined,
  });
  try {
    await transport.sendMail({
      from: identity.header,
      to: email.to_email,
      subject: email.subject,
      text: email.body,
    });
  } catch (error) {
    db.prepare("UPDATE emails SET status = 'failed', error = ? WHERE id = ?").run(String(error.message || error).slice(0, 500), emailId);
    throw new Error("SMTP could not send that message. It is still in the thread.");
  }
  db.prepare("UPDATE emails SET status = 'sent', sent_at = ?, error = '' WHERE id = ?").run(now, emailId);
  db.prepare("UPDATE email_threads SET updated_at = ?, subject = ? WHERE id = ?").run(now, email.subject, email.thread_id);
  return { delivered: true, status: "sent" };
}

function insertOutbound({ threadId, leadId, to, subject, body, triggerKey, status }) {
  const now = nowIso();
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO emails (
      id, thread_id, lead_id, direction, status, from_email, to_email, subject, body, trigger_key, created_at
    ) VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?)
  `).run(id, threadId, leadId, status, mailIdentity().address, to, subject, body, triggerKey || "", now);
  db.prepare("UPDATE email_threads SET subject = ?, updated_at = ? WHERE id = ?").run(subject, now, threadId);
  return id;
}

app.get("/api/inbox", (req, res) => {
  const folder = String(req.query.folder || "all");
  const params = [];
  let sqlWhere = folderSql(folder);
  if (req.query.search) {
    const like = `%${String(req.query.search).trim()}%`;
    sqlWhere += ` AND (t.subject LIKE ? OR leads.name LIKE ? OR leads.company LIKE ? OR leads.email LIKE ? OR EXISTS (SELECT 1 FROM emails e WHERE e.thread_id = t.id AND (e.body LIKE ? OR e.subject LIKE ?)))`;
    params.push(like, like, like, like, like, like);
  }
  const threads = db.prepare(`${threadSelect} WHERE 1 = 1 ${sqlWhere} ORDER BY t.updated_at DESC`).all(...params).map(mapThread);
  res.json({
    threads,
    suggestions: folder === "idle" ? idleSuggestions() : [],
    summary: inboxSummary(),
    snippets: db.prepare("SELECT id, name, subject, body FROM snippets ORDER BY name COLLATE NOCASE").all(),
  });
});

app.get("/api/inbox/threads/:id", (req, res) => {
  const detail = getThreadDetail(req.params.id, { markRead: true });
  if (!detail) {
    res.status(404).json({ error: "Thread not found." });
    return;
  }
  res.json(detail);
});

app.post("/api/inbox/threads", async (req, res) => {
  const subject = String(req.body?.subject ?? "").trim();
  const body = String(req.body?.body ?? "");
  if (!subject && !body.trim()) {
    res.status(400).json({ error: "Write a subject or a message." });
    return;
  }
  const lead = req.body?.leadId ? getLead(req.body.leadId) : null;
  if (req.body?.leadId && !lead) {
    res.status(404).json({ error: "Lead not found." });
    return;
  }
  const to = String(req.body?.to ?? lead?.email ?? "").trim();
  const triggerKey = ["no_answer", "voicemail", "idle", "demo", ""].includes(req.body?.triggerKey) ? String(req.body?.triggerKey || "") : "";
  const sending = Boolean(req.body?.send);
  const now = nowIso();
  const threadId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO email_threads (id, lead_id, subject, trigger_key, triggers_paused, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(threadId, lead?.id || null, subject || "(no subject)", triggerKey, sending && req.body?.pauseTriggers ? 1 : 0, now, now);
  const emailId = insertOutbound({
    threadId,
    leadId: lead?.id || null,
    to,
    subject: subject || "(no subject)",
    body,
    triggerKey,
    status: sending ? "queued" : "draft",
  });
  try {
    if (sending) await deliverEmail(emailId);
  } catch (error) {
    res.status(502).json({ error: error.message, thread: getThreadDetail(threadId) });
    return;
  }
  res.status(201).json(getThreadDetail(threadId));
});

app.post("/api/inbox/threads/:id/reply", async (req, res) => {
  const existing = db.prepare("SELECT * FROM email_threads WHERE id = ?").get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: "Thread not found." });
    return;
  }
  const body = String(req.body?.body ?? "");
  const subject = String(req.body?.subject ?? existing.subject);
  const lead = existing.lead_id ? getLead(existing.lead_id) : null;
  const previous = db.prepare("SELECT to_email FROM emails WHERE thread_id = ? AND to_email != '' ORDER BY created_at DESC").get(existing.id);
  const to = String(req.body?.to ?? previous?.to_email ?? lead?.email ?? "").trim();
  const sending = Boolean(req.body?.send);
  if (sending && req.body?.pauseTriggers) {
    db.prepare("UPDATE email_threads SET triggers_paused = 1 WHERE id = ?").run(existing.id);
  }
  let emailId;
  const draft = db.prepare("SELECT * FROM emails WHERE thread_id = ? AND direction = 'outbound' AND status = 'draft' ORDER BY created_at DESC").get(existing.id);
  if (draft) {
    emailId = draft.id;
    db.prepare("UPDATE emails SET to_email = ?, subject = ?, body = ?, status = ? WHERE id = ?").run(to, subject, body, sending ? "queued" : "draft", draft.id);
  } else {
    emailId = insertOutbound({ threadId: existing.id, leadId: existing.lead_id, to, subject, body, triggerKey: existing.trigger_key, status: sending ? "queued" : "draft" });
  }
  try {
    if (sending) await deliverEmail(emailId);
  } catch (error) {
    res.status(502).json({ error: error.message, thread: getThreadDetail(existing.id) });
    return;
  }
  res.json(getThreadDetail(existing.id));
});

app.post("/api/inbox/threads/:id/inbound", (req, res) => {
  const existing = db.prepare("SELECT * FROM email_threads WHERE id = ?").get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: "Thread not found." });
    return;
  }
  const body = String(req.body?.body ?? "").trim();
  if (!body) {
    res.status(400).json({ error: "Paste the reply first." });
    return;
  }
  const lead = existing.lead_id ? getLead(existing.lead_id) : null;
  const now = nowIso();
  db.prepare(`
    INSERT INTO emails (
      id, thread_id, lead_id, direction, status, from_email, to_email, subject, body, trigger_key, created_at
    ) VALUES (?, ?, ?, 'inbound', 'received', ?, ?, ?, ?, '', ?)
  `).run(crypto.randomUUID(), existing.id, existing.lead_id, String(req.body?.from || lead?.email || ""), mailIdentity().address, existing.subject, body, now);
  db.prepare("UPDATE email_threads SET triggers_paused = 1, updated_at = ? WHERE id = ?").run(now, existing.id);
  res.status(201).json(getThreadDetail(existing.id));
});

app.patch("/api/inbox/threads/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM email_threads WHERE id = ?").get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: "Thread not found." });
    return;
  }
  if (req.body?.triggersPaused !== undefined) {
    db.prepare("UPDATE email_threads SET triggers_paused = ?, updated_at = ? WHERE id = ?")
      .run(req.body.triggersPaused ? 1 : 0, nowIso(), existing.id);
  }
  res.json(getThreadDetail(existing.id));
});

app.delete("/api/inbox/threads/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM email_threads WHERE id = ?").get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: "Thread not found." });
    return;
  }
  db.prepare("DELETE FROM email_threads WHERE id = ?").run(existing.id);
  res.json({ id: existing.id });
});

app.get("/api/snippets", (_req, res) => {
  res.json(db.prepare("SELECT id, name, subject, body, created_at AS createdAt FROM snippets ORDER BY name COLLATE NOCASE").all());
});

app.post("/api/snippets", (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const body = String(req.body?.body ?? "");
  if (!name || !body.trim()) {
    res.status(400).json({ error: "A snippet needs a name and a body." });
    return;
  }
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO snippets (id, name, subject, body, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, name, String(req.body?.subject ?? "").trim(), body, nowIso());
  res.status(201).json(db.prepare("SELECT id, name, subject, body, created_at AS createdAt FROM snippets WHERE id = ?").get(id));
});

app.delete("/api/snippets/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM snippets WHERE id = ?").get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: "Snippet not found." });
    return;
  }
  db.prepare("DELETE FROM snippets WHERE id = ?").run(existing.id);
  res.json(existing);
});

const WEBHOOK_EVENTS = [
  "lead.created", "lead.updated", "lead.archived", "lead.restored", "lead.dialed",
  "lead.disposition", "lead.attempts_reset", "campaign.enrolled",
  "email.drafted", "email.sent", "email.local", "email.failed",
  "webhook.test",
];
const FLOW_TYPES = new Set(["start", "dial", "email", "wait", "end"]);

function leadSnapshot(lead) {
  if (!lead) return null;
  return {
    id: lead.id,
    name: lead.name,
    phone: lead.phone,
    email: lead.email || "",
    company: lead.company || "",
    status: lead.status,
    stage: lead.stage,
    attempts: lead.attempts,
    archived: Boolean(lead.archived),
    campaignId: lead.campaignId || null,
    inQueue: Boolean(lead.inQueue),
    flowNodeId: lead.flowNodeId || "",
  };
}

function recordDelivery(id, webhookId, event, status, responseCode, error) {
  try {
    db.prepare(`
      INSERT INTO webhook_deliveries (id, webhook_id, event, status, response_code, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, webhookId, event, status, responseCode, String(error || "").slice(0, 300), nowIso());
  } catch (err) {
    console.error("webhook delivery", err);
  }
}

function deliverHook(hook, event, data) {
  const body = JSON.stringify({ event, sentAt: nowIso(), data });
  const signature = hook.secret ? createHmac("sha256", hook.secret).update(body).digest("hex") : "";
  const deliveryId = crypto.randomUUID();
  return fetch(hook.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-MyDial-Event": event,
      ...(signature ? { "X-MyDial-Signature": signature } : {}),
    },
    body,
    signal: AbortSignal.timeout(8000),
  }).then((response) => {
    const error = response.ok ? "" : `HTTP ${response.status}`;
    recordDelivery(deliveryId, hook.id, event, response.ok ? "ok" : "error", response.status, error);
    return { status: response.ok ? "ok" : "error", responseCode: response.status, error };
  }).catch((error) => {
    const message = String(error.message || error).slice(0, 300);
    recordDelivery(deliveryId, hook.id, event, "error", null, message);
    return { status: "error", responseCode: null, error: message };
  });
}

function emitWebhook(event, data) {
  try {
    const hooks = db.prepare("SELECT * FROM webhooks WHERE active = 1").all();
    for (const hook of hooks) {
      let events = [];
      try { events = JSON.parse(hook.events || "[]"); } catch { events = []; }
      if (events.length && !events.includes("*") && !events.includes(event)) continue;
      void deliverHook(hook, event, data);
    }
  } catch (error) {
    console.error("webhook", error);
  }
}

function mapWebhook(row) {
  let events = [];
  try { events = JSON.parse(row.events || "[]"); } catch { events = []; }
  const deliveries = db.prepare(`
    SELECT id, event, status, response_code AS responseCode, error, created_at AS createdAt
    FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT 5
  `).all(row.id);
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    events,
    active: Boolean(row.active),
    hasSecret: Boolean(row.secret),
    createdAt: row.created_at,
    deliveries,
  };
}

function flowNode(flow, id) {
  return flow.nodes.find((node) => node.id === id) || null;
}

function nextEdge(flow, sourceId, handle) {
  const edges = flow.edges.filter((edge) => edge.source === sourceId);
  if (handle) {
    const matched = edges.find((edge) => (edge.sourceHandle || "") === handle);
    if (matched) return matched;
  }
  return edges.find((edge) => !edge.sourceHandle) || null;
}

function normalizeFlow(input) {
  if (!input || !Array.isArray(input.nodes) || !input.nodes.length) return null;
  const nodes = input.nodes.filter((node) => node && FLOW_TYPES.has(node.type) && node.id).map((node) => ({
    id: String(node.id),
    type: node.type,
    position: { x: Number(node.position?.x) || 0, y: Number(node.position?.y) || 0 },
    data: {
      label: String(node.data?.label || node.type),
      hours: Number(node.data?.hours) || 0,
      maxAttempts: Number(node.data?.maxAttempts) || 0,
      retryMinutes: Number(node.data?.retryMinutes) || 0,
      subject: String(node.data?.subject || ""),
      body: String(node.data?.body || ""),
      autoSend: Boolean(node.data?.autoSend),
    },
  }));
  if (!nodes.some((node) => node.type === "start") && !nodes.length) return null;
  if (!nodes.length) return null;
  const ids = new Set(nodes.map((node) => node.id));
  const edges = (Array.isArray(input.edges) ? input.edges : [])
    .filter((edge) => edge && ids.has(String(edge.source)) && ids.has(String(edge.target)))
    .map((edge) => ({
      id: String(edge.id || crypto.randomUUID()),
      source: String(edge.source),
      target: String(edge.target),
      ...(edge.sourceHandle ? { sourceHandle: String(edge.sourceHandle) } : {}),
      ...(edge.label ? { label: String(edge.label) } : {}),
    }));
  return { nodes, edges };
}

function fileFlowEmail(lead, node) {
  if (!lead?.email) return null;
  const subject = fillMail(node.data?.subject || node.data?.label || "Following up", lead);
  const body = fillMail(node.data?.body || "", lead);
  const now = nowIso();
  const threadId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO email_threads (id, lead_id, subject, trigger_key, triggers_paused, created_at, updated_at)
    VALUES (?, ?, ?, 'flow', 0, ?, ?)
  `).run(threadId, lead.id, subject, now, now);
  const emailId = insertOutbound({
    threadId,
    leadId: lead.id,
    to: lead.email,
    subject,
    body,
    triggerKey: "flow",
    status: node.data?.autoSend ? "queued" : "draft",
  });
  if (node.data?.autoSend && settingValue("smtpHost")) {
    void deliverEmail(emailId).then(() => {
      emitWebhook("email.sent", { leadId: lead.id, emailId, subject });
    }).catch(() => {
      emitWebhook("email.failed", { leadId: lead.id, emailId, subject });
    });
  } else if (node.data?.autoSend) {
    db.prepare("UPDATE emails SET status = 'local', sent_at = ? WHERE id = ?").run(now, emailId);
    emitWebhook("email.local", { leadId: lead.id, emailId, subject });
  } else {
    emitWebhook("email.drafted", { leadId: lead.id, emailId, subject });
  }
  return emailId;
}

function enterFlowNode(leadId, flow, node, hops) {
  if (!node || hops > 12) {
    db.prepare("UPDATE leads SET in_queue = 0, flow_node_id = '', next_attempt_at = NULL, updated_at = ? WHERE id = ?")
      .run(nowIso(), leadId);
    return;
  }
  if (node.type === "start") {
    db.prepare("UPDATE leads SET flow_node_id = ?, updated_at = ? WHERE id = ?").run(node.id, nowIso(), leadId);
    const edge = nextEdge(flow, node.id);
    enterFlowNode(leadId, flow, edge ? flowNode(flow, edge.target) : null, hops + 1);
    return;
  }
  if (node.type === "end") {
    db.prepare("UPDATE leads SET in_queue = 0, flow_node_id = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ?")
      .run(node.id, nowIso(), leadId);
    return;
  }
  if (node.type === "dial") {
    db.prepare(`
      UPDATE leads SET in_queue = 1, flow_node_id = ?, queue_order = ?, next_attempt_at = NULL, updated_at = ?
      WHERE id = ? AND archived = 0 AND status != 'dnc'
    `).run(node.id, nextQueueOrder(), nowIso(), leadId);
    return;
  }
  if (node.type === "wait") {
    const at = new Date(Date.now() + (Number(node.data?.hours) || 0) * 3600000).toISOString();
    db.prepare("UPDATE leads SET in_queue = 0, flow_node_id = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?")
      .run(node.id, at, nowIso(), leadId);
    return;
  }
  if (node.type === "email") {
    db.prepare("UPDATE leads SET flow_node_id = ?, updated_at = ? WHERE id = ?").run(node.id, nowIso(), leadId);
    fileFlowEmail(getLead(leadId), node);
    const edge = nextEdge(flow, node.id);
    enterFlowNode(leadId, flow, edge ? flowNode(flow, edge.target) : null, hops + 1);
  }
}

function enrollLead(leadId) {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId);
  if (!lead?.campaign_id || lead.archived || lead.status === "dnc" || lead.flow_node_id) return;
  const campaign = db.prepare("SELECT flow_json FROM campaigns WHERE id = ?").get(lead.campaign_id);
  const flow = parseFlow(campaign?.flow_json);
  if (!flow) return;
  const start = flow.nodes.find((node) => node.type === "start") || flow.nodes[0];
  enterFlowNode(lead.id, flow, start, 0);
  emitWebhook("campaign.enrolled", { leadId: lead.id, campaignId: lead.campaign_id, flowNodeId: getLead(lead.id)?.flowNodeId || "" });
}

function advanceFromDial(leadId, outcome, attempts) {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId);
  if (!lead?.campaign_id) return false;
  const campaign = db.prepare("SELECT flow_json FROM campaigns WHERE id = ?").get(lead.campaign_id);
  const flow = parseFlow(campaign?.flow_json);
  if (!flow) return false;
  const node = flowNode(flow, lead.flow_node_id) || flow.nodes.find((item) => item.type === "dial");
  const stay = outcome === "no_answer" || outcome === "voicemail";
  if (!node || node.type !== "dial") {
    if (!stay) {
      db.prepare("UPDATE leads SET in_queue = 0, next_attempt_at = NULL, updated_at = ? WHERE id = ?").run(nowIso(), leadId);
    }
    return true;
  }
  const cap = Number(node.data?.maxAttempts || 0);
  const handle = stay && cap && attempts >= cap ? "max" : outcome;
  const edge = nextEdge(flow, node.id, handle);
  if (edge) {
    enterFlowNode(leadId, flow, flowNode(flow, edge.target), 0);
    return true;
  }
  if (!stay || (cap && attempts >= cap)) {
    db.prepare("UPDATE leads SET in_queue = 0, next_attempt_at = NULL, updated_at = ? WHERE id = ?").run(nowIso(), leadId);
    return true;
  }
  const minutes = Number(node.data?.retryMinutes || 0);
  const nextAt = minutes ? new Date(Date.now() + minutes * 60000).toISOString() : null;
  db.prepare("UPDATE leads SET in_queue = 1, queue_order = ?, next_attempt_at = ?, flow_node_id = ?, updated_at = ? WHERE id = ?")
    .run(nextQueueOrder(), nextAt, node.id, nowIso(), leadId);
  return true;
}

function releaseDueWaits() {
  const waiting = db.prepare(`
    SELECT leads.id, leads.flow_node_id, campaigns.flow_json
    FROM leads
    JOIN campaigns ON campaigns.id = leads.campaign_id
    WHERE leads.archived = 0 AND leads.flow_node_id != '' AND leads.next_attempt_at IS NOT NULL AND leads.next_attempt_at <= ?
  `).all(nowIso());
  for (const row of waiting) {
    const flow = parseFlow(row.flow_json);
    const node = flow ? flowNode(flow, row.flow_node_id) : null;
    if (!flow || node?.type !== "wait") continue;
    const edge = nextEdge(flow, node.id);
    enterFlowNode(row.id, flow, edge ? flowNode(flow, edge.target) : null, 0);
  }
}

app.post("/api/leads/:id/archive", (req, res) => {
  const existing = getLead(req.params.id);
  if (!existing) {
    res.status(404).json({ error: "Lead not found." });
    return;
  }
  const archived = req.body?.archived === undefined ? true : Boolean(req.body.archived);
  db.prepare(`
    UPDATE leads SET archived = ?, in_queue = CASE WHEN ? = 1 THEN 0 ELSE in_queue END, updated_at = ? WHERE id = ?
  `).run(archived ? 1 : 0, archived ? 1 : 0, nowIso(), existing.id);
  const lead = getLead(existing.id);
  emitWebhook(archived ? "lead.archived" : "lead.restored", leadSnapshot(lead));
  res.json(lead);
});

app.post("/api/leads/:id/reset-attempts", (req, res) => {
  const existing = getLead(req.params.id);
  if (!existing) {
    res.status(404).json({ error: "Lead not found." });
    return;
  }
  db.prepare("UPDATE leads SET attempts = 0, updated_at = ? WHERE id = ?").run(nowIso(), existing.id);
  const lead = getLead(existing.id);
  emitWebhook("lead.attempts_reset", leadSnapshot(lead));
  res.json(lead);
});

app.get("/api/webhooks", (_req, res) => {
  res.json(db.prepare("SELECT * FROM webhooks ORDER BY created_at DESC").all().map(mapWebhook));
});

app.post("/api/webhooks", (req, res) => {
  const url = String(req.body?.url ?? "").trim();
  let parsed;
  try { parsed = new URL(url); } catch { parsed = null; }
  if (!parsed || !["http:", "https:"].includes(parsed.protocol)) {
    res.status(400).json({ error: "Webhook URL must start with http:// or https://." });
    return;
  }
  const events = Array.isArray(req.body?.events) ? req.body.events.map(String).filter((event) => WEBHOOK_EVENTS.includes(event)) : [];
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO webhooks (id, name, url, secret, events, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    String(req.body?.name ?? "").trim() || parsed.host,
    url,
    String(req.body?.secret ?? ""),
    JSON.stringify(events),
    req.body?.active === false ? 0 : 1,
    nowIso(),
  );
  res.status(201).json(mapWebhook(db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id)));
});

app.delete("/api/webhooks/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM webhooks WHERE id = ?").get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: "Webhook not found." });
    return;
  }
  db.prepare("DELETE FROM webhook_deliveries WHERE webhook_id = ?").run(existing.id);
  db.prepare("DELETE FROM webhooks WHERE id = ?").run(existing.id);
  res.json({ id: existing.id });
});

app.post("/api/webhooks/:id/test", async (req, res) => {
  const hook = db.prepare("SELECT * FROM webhooks WHERE id = ?").get(req.params.id);
  if (!hook) {
    res.status(404).json({ error: "Webhook not found." });
    return;
  }
  const result = await deliverHook(hook, "webhook.test", { ok: true, message: "MyDial test event" });
  res.json(result);
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "Something went wrong." });
});

app.listen(PORT, () => {
  console.log(`MyDial running at http://localhost:${PORT}`);
});
