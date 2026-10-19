import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath, pathToFileURL } from "url";

const ACTIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "coach-actions");
const OUTCOMES = new Set(["positive", "not_interested", "voicemail", "no_answer", "dnc"]);
const KINDS = new Set(["coach", "review", "note", "me", "prospect"]);

const STARTERS = [
  ["disp-positive", "Interested", "1", "disposition", { outcome: "positive" }, "1", 1],
  ["disp-not", "Not interested", "2", "disposition", { outcome: "not_interested" }, "2", 2],
  ["disp-vm", "Voicemail", "3", "disposition", { outcome: "voicemail" }, "3", 3],
  ["disp-na", "No answer", "4", "disposition", { outcome: "no_answer" }, "4", 4],
  ["disp-dnc", "Do not call", "5", "disposition", { outcome: "dnc" }, "5", 5],
  ["steer-well", "Going well", "☺", "steer", { text: "The call is going well. On the next reply, help Me build on what is working." }, "6", 6],
  ["steer-poor", "Going poorly", "☹", "steer", { text: "The call is going poorly. On the next reply, help Me recover." }, "7", 7],
  ["steer-price", "Price concern", "$", "steer", { text: "Price just came up. On the next reply, help Me handle the cost concern." }, "8", 8],
  ["steer-gate", "Gatekeeper", "G", "steer", { text: "This is a gatekeeper. On the next reply, help Me get to the decision maker." }, "9", 9],
  ["steer-decision", "Decision maker", "D", "steer", { text: "Me is talking to the decision maker. On the next reply, help Me advance the conversation." }, "0", 10],
  ["steer-send", "Send info", "→", "steer", { text: "They asked for information. On the next reply, help Me confirm what to send and the next step." }, "NumpadAdd", 11],
  ["steer-meet", "Book a meeting", "▣", "steer", { text: "Me should try to book a meeting. On the next reply, help Me offer a specific time." }, "NumpadSubtract", 12],
  ["steer-later", "Not now", "…", "steer", { text: "Now is not a good time. On the next reply, help Me exit cleanly and set a follow-up." }, "NumpadMultiply", 13],
];

export function prepareCoachThread(db) {
  fs.mkdirSync(ACTIONS_DIR, { recursive: true });
  const addColumn = (table, column, ddl) => {
    const names = db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
    if (!names.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  addColumn("coach_sessions", "root_id", "root_id TEXT NOT NULL DEFAULT ''");
  addColumn("coach_sessions", "pending_steer", "pending_steer TEXT NOT NULL DEFAULT ''");
  addColumn("coach_messages", "sibling_of", "sibling_of TEXT NOT NULL DEFAULT ''");
  addColumn("coach_messages", "active", "active INTEGER NOT NULL DEFAULT 1");
  addColumn("coach_messages", "rating", "rating TEXT NOT NULL DEFAULT ''");
  addColumn("coach_messages", "meta_json", "meta_json TEXT NOT NULL DEFAULT ''");
  db.exec(`
    CREATE TABLE IF NOT EXISTS coach_actions (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '',
      placement TEXT NOT NULL DEFAULT 'strip',
      kinds_json TEXT NOT NULL DEFAULT '[]',
      effect TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      shortcut TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      builtin INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1
    );
  `);
  const insert = db.prepare(`
    INSERT INTO coach_actions (id, label, icon, placement, kinds_json, effect, payload_json, shortcut, sort_order, builtin, enabled)
    VALUES (?, ?, ?, 'strip', '[]', ?, ?, ?, ?, 1, 1)
  `);
  for (const [id, label, icon, effect, payload, shortcut, order] of STARTERS) {
    if (!db.prepare("SELECT id FROM coach_actions WHERE id = ?").get(id)) {
      insert.run(id, label, icon, effect, JSON.stringify(payload), shortcut, order);
    }
  }
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text || "");
  } catch {
    return fallback;
  }
}

function mapAction(row, source = "app") {
  return {
    id: row.id,
    label: row.label,
    icon: row.icon,
    placement: row.placement,
    kinds: parseJson(row.kinds_json, []),
    effect: row.effect,
    payload: parseJson(row.payload_json, {}),
    shortcut: row.shortcut,
    sortOrder: row.sort_order,
    builtin: Boolean(row.builtin),
    enabled: Boolean(row.enabled),
    source,
  };
}

async function loadPlugins() {
  if (!fs.existsSync(ACTIONS_DIR)) return [];
  const files = fs.readdirSync(ACTIONS_DIR).filter((name) => name.endsWith(".js")).sort();
  const plugins = [];
  for (const name of files) {
    const full = path.join(ACTIONS_DIR, name);
    try {
      const version = fs.statSync(full).mtimeMs;
      const loaded = await import(`${pathToFileURL(full).href}?v=${version}`);
      const action = loaded.default;
      if (!action?.id || typeof action.run !== "function") continue;
      plugins.push({
        id: `plugin:${action.id}`,
        label: String(action.label || action.id).slice(0, 40),
        icon: String(action.icon || "•").slice(0, 8),
        placement: action.placement === "strip" ? "strip" : "message",
        kinds: Array.isArray(action.kinds) ? action.kinds.filter((kind) => KINDS.has(kind)) : ["coach"],
        effect: "plugin",
        payload: {},
        shortcut: String(action.shortcut || ""),
        sortOrder: 100 + plugins.length,
        builtin: false,
        enabled: true,
        source: "plugin",
        run: action.run,
      });
    } catch (error) {
      console.error(`Coach action ${name} did not load:`, error.message);
    }
  }
  return plugins;
}

export function attachCoachThread(app, { db, nowIso, sessionRow, mapSession, coachTurn, addMessage, saveDoc, rememberLine, openCoachStream, wantsCoachStream }) {
  function messageRow(id) {
    return db.prepare("SELECT * FROM coach_messages WHERE id = ?").get(id);
  }

  function groupOf(row) {
    return row.sibling_of || row.id;
  }

  function selectSibling(id) {
    const row = messageRow(id);
    if (!row) return null;
    const group = groupOf(row);
    db.prepare(`
      UPDATE coach_messages
      SET active = CASE WHEN id = ? THEN 1 ELSE 0 END
      WHERE session_id = ? AND (id = ? OR sibling_of = ?)
    `).run(id, row.session_id, group, group);
    return row;
  }

  function readActionBody(body) {
    const label = String(body?.label || "").trim().slice(0, 40);
    const icon = String(body?.icon || "•").trim().slice(0, 8) || "•";
    const placement = body?.placement === "message" ? "message" : "strip";
    const effect = String(body?.effect || "");
    const shortcut = String(body?.shortcut || "").trim().slice(0, 20);
    const kinds = Array.isArray(body?.kinds) ? body.kinds.filter((kind) => KINDS.has(kind)) : [];
    const payload = body?.payload && typeof body.payload === "object" ? body.payload : {};
    if (!label) return { error: "Name the action." };
    if (!["steer", "disposition", "prompt", "notepad", "memory"].includes(effect)) return { error: "Choose what the action does." };
    if (effect === "disposition" && !OUTCOMES.has(payload.outcome)) return { error: "Choose a disposition." };
    if (effect === "steer" && !String(payload.text || "").trim()) return { error: "Say what this tells the coach." };
    if (effect === "prompt" && !String(payload.prompt || "").trim()) return { error: "Write the prompt for this action." };
    if (placement === "message" && !kinds.length) return { error: "Choose which messages show this action." };
    return { label, icon, placement, effect, shortcut, kinds, payload };
  }

  async function listActions() {
    const saved = db.prepare("SELECT * FROM coach_actions ORDER BY sort_order, label").all().map((row) => mapAction(row));
    const plugins = await loadPlugins();
    return [...saved, ...plugins];
  }

  app.get("/api/coach/actions", async (_req, res) => {
    res.json(await listActions());
  });

  app.post("/api/coach/actions", (req, res) => {
    const parsed = readActionBody(req.body);
    if (parsed.error) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const id = crypto.randomUUID();
    const order = (db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS max FROM coach_actions").get().max || 0) + 1;
    db.prepare(`
      INSERT INTO coach_actions (id, label, icon, placement, kinds_json, effect, payload_json, shortcut, sort_order, builtin, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)
    `).run(id, parsed.label, parsed.icon, parsed.placement, JSON.stringify(parsed.kinds), parsed.effect, JSON.stringify(parsed.payload), parsed.shortcut, order);
    res.status(201).json(mapAction(db.prepare("SELECT * FROM coach_actions WHERE id = ?").get(id)));
  });

  app.patch("/api/coach/actions/:id", (req, res) => {
    const row = db.prepare("SELECT * FROM coach_actions WHERE id = ?").get(req.params.id);
    if (!row) {
      res.status(404).json({ error: "Action not found." });
      return;
    }
    if (req.body?.enabled !== undefined && Object.keys(req.body).length === 1) {
      db.prepare("UPDATE coach_actions SET enabled = ? WHERE id = ?").run(req.body.enabled ? 1 : 0, row.id);
      res.json(mapAction(db.prepare("SELECT * FROM coach_actions WHERE id = ?").get(row.id)));
      return;
    }
    const parsed = readActionBody({ ...mapAction(row), ...req.body, payload: req.body?.payload || mapAction(row).payload });
    if (parsed.error) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    db.prepare(`
      UPDATE coach_actions
      SET label = ?, icon = ?, placement = ?, kinds_json = ?, effect = ?, payload_json = ?, shortcut = ?
      WHERE id = ?
    `).run(parsed.label, parsed.icon, parsed.placement, JSON.stringify(parsed.kinds), parsed.effect, JSON.stringify(parsed.payload), parsed.shortcut, row.id);
    res.json(mapAction(db.prepare("SELECT * FROM coach_actions WHERE id = ?").get(row.id)));
  });

  app.delete("/api/coach/actions/:id", (req, res) => {
    const row = db.prepare("SELECT * FROM coach_actions WHERE id = ?").get(req.params.id);
    if (!row) {
      res.status(404).json({ error: "Action not found." });
      return;
    }
    if (row.builtin) {
      res.status(400).json({ error: "Built-in actions can be turned off, not deleted." });
      return;
    }
    db.prepare("DELETE FROM coach_actions WHERE id = ?").run(row.id);
    res.json({ id: row.id });
  });

  app.post("/api/coach/sessions/:id/steer", (req, res) => {
    const row = sessionRow(req.params.id);
    if (!row) {
      res.status(404).json({ error: "Coach thread not found." });
      return;
    }
    const text = String(req.body?.text || "").trim().slice(0, 500);
    const label = String(req.body?.label || "Direction").trim().slice(0, 40);
    if (!text) {
      res.status(400).json({ error: "Say which way to steer." });
      return;
    }
    db.prepare("UPDATE coach_sessions SET pending_steer = ? WHERE id = ?").run(text, row.id);
    addMessage(row.id, { kind: "status", speaker: "Coach", body: `Noted: ${label}. The coach will use it on the next reply.` });
    res.json(mapSession(sessionRow(row.id)));
  });

  app.post("/api/coach/sessions/:id/branch", (req, res) => {
    const row = sessionRow(req.params.id);
    const message = messageRow(req.body?.messageId);
    if (!row || !message || message.session_id !== row.id) {
      res.status(404).json({ error: "That reply is not in this thread." });
      return;
    }
    const root = row.root_id || row.id;
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO coach_sessions (id, lead_id, root_id, created_at) VALUES (?, ?, ?, ?)").run(id, row.lead_id, root, nowIso());
    const source = db.prepare(`
      SELECT * FROM coach_messages
      WHERE session_id = ? AND active = 1 AND created_at <= ?
      ORDER BY created_at, rowid
    `).all(row.id, message.created_at);
    const insert = db.prepare(`
      INSERT INTO coach_messages (id, session_id, kind, speaker, body, audio_path, created_at, sibling_of, active, rating, meta_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, '', 1, ?, ?)
    `);
    for (const item of source) {
      insert.run(crypto.randomUUID(), id, item.kind, item.speaker, item.body, item.audio_path, item.created_at, item.rating, item.meta_json || "");
    }
    res.status(201).json(mapSession(sessionRow(id)));
  });

  app.post("/api/coach/messages/:id/select", (req, res) => {
    const row = selectSibling(req.params.id);
    if (!row) {
      res.status(404).json({ error: "Line not found." });
      return;
    }
    res.json(mapSession(sessionRow(row.session_id)));
  });

  app.post("/api/coach/messages/:id/edit", async (req, res) => {
    try {
      const row = messageRow(req.params.id);
      if (!row) {
        res.status(404).json({ error: "Line not found." });
        return;
      }
      const body = String(req.body?.body || "").trim().slice(0, 4000);
      if (!body) {
        res.status(400).json({ error: "The message cannot be empty." });
        return;
      }
      db.prepare("UPDATE coach_messages SET body = ? WHERE id = ?").run(body, row.id);
      const rewrite = row.kind === "note";
      if (!rewrite) {
        res.json(mapSession(sessionRow(row.session_id)));
        return;
      }
      const later = db.prepare(`
        SELECT id FROM coach_messages
        WHERE session_id = ? AND created_at > ? AND kind IN ('coach', 'review', 'status')
      `).all(row.session_id, row.created_at);
      for (const item of later) {
        db.prepare("DELETE FROM coach_corrections WHERE message_id = ?").run(item.id);
        db.prepare("DELETE FROM coach_messages WHERE id = ?").run(item.id);
      }
      const send = wantsCoachStream(req) ? openCoachStream(res) : null;
      if (send) send({ type: "start" });
      await coachTurn(row.session_id, { mode: "note", noteId: row.id, onEvent: send });
      const session = mapSession(sessionRow(row.session_id));
      if (send) {
        send({ type: "done", session });
        res.end();
      } else res.json(session);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.status(500).json({ error: "The coach could not rewrite from that note." });
      else if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: "error", error: "The coach could not rewrite from that note." })}\n\n`);
        res.end();
      }
    }
  });

  app.post("/api/coach/messages/:id/regenerate", async (req, res) => {
    try {
      const row = messageRow(req.params.id);
      if (!row || row.kind !== "coach") {
        res.status(404).json({ error: "Only a coach reply can be regenerated." });
        return;
      }
      const send = wantsCoachStream(req) ? openCoachStream(res) : null;
      if (send) send({ type: "start" });
      const prior = db.prepare(`
        SELECT kind FROM coach_messages
        WHERE session_id = ? AND created_at < ? AND active = 1 AND kind IN ('note', 'prospect', 'me')
        ORDER BY created_at DESC LIMIT 1
      `).get(row.session_id, row.created_at);
      await coachTurn(row.session_id, {
        mode: prior?.kind === "note" ? "note" : "turn",
        untilMessageId: row.id,
        siblingOf: groupOf(row),
        siblingCreatedAt: row.created_at,
        onEvent: send,
      });
      const session = mapSession(sessionRow(row.session_id));
      if (send) {
        send({ type: "done", session });
        res.end();
      } else res.json(session);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.status(500).json({ error: "The coach could not regenerate that reply." });
      else if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: "error", error: "The coach could not regenerate that reply." })}\n\n`);
        res.end();
      }
    }
  });

  app.post("/api/coach/messages/:id/continue", async (req, res) => {
    try {
      const row = messageRow(req.params.id);
      if (!row || row.kind !== "coach") {
        res.status(404).json({ error: "Only a coach reply can be continued." });
        return;
      }
      const send = wantsCoachStream(req) ? openCoachStream(res) : null;
      if (send) send({ type: "start" });
      const result = await coachTurn(row.session_id, { mode: "continue", continueBody: row.body, returnText: true, onEvent: send });
      const next = `${row.body.trim()}\n${String(result?.body || "").trim()}`.trim();
      db.prepare("UPDATE coach_messages SET body = ?, meta_json = ? WHERE id = ?").run(next, JSON.stringify(result?.meta || {}), row.id);
      const session = mapSession(sessionRow(row.session_id));
      if (send) {
        send({ type: "done", session });
        res.end();
      } else res.json(session);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.status(500).json({ error: "The coach could not continue that reply." });
      else if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: "error", error: "The coach could not continue that reply." })}\n\n`);
        res.end();
      }
    }
  });

  app.post("/api/coach/messages/:id/feedback", (req, res) => {
    const row = messageRow(req.params.id);
    if (!row || (row.kind !== "coach" && row.kind !== "review")) {
      res.status(404).json({ error: "That line cannot be rated." });
      return;
    }
    const vote = req.body?.vote === "down" ? "down" : req.body?.vote === "up" ? "up" : "";
    if (!vote) {
      res.status(400).json({ error: "Choose up or down." });
      return;
    }
    if (row.rating === vote) {
      db.prepare("UPDATE coach_messages SET rating = '' WHERE id = ?").run(row.id);
      res.json(mapSession(sessionRow(row.session_id)));
      return;
    }
    db.prepare("UPDATE coach_messages SET rating = ? WHERE id = ?").run(vote, row.id);
    if (vote === "up") {
      const session = mapSession(sessionRow(row.session_id));
      rememberLine(`Good coach reply for ${session.leadName}: ${row.body}`, session.leadId);
    }
    if (vote === "down") {
      const reason = String(req.body?.reason || "").trim();
      if (!reason) {
        db.prepare("UPDATE coach_messages SET rating = ? WHERE id = ?").run(row.rating, row.id);
        res.status(400).json({ error: "Say what was wrong." });
        return;
      }
      const id = crypto.randomUUID();
      db.prepare("INSERT INTO coach_corrections (id, message_id, reason, created_at) VALUES (?, ?, ?, ?)").run(id, row.id, reason.slice(0, 2000), nowIso());
      const session = mapSession(sessionRow(row.session_id));
      const nearby = session.messages.filter((item) => item.kind === "prospect" || item.kind === "me").slice(-4)
        .map((item) => `${item.speaker}: ${item.body}`).join(" ");
      saveDoc(`correction:${id}`, "correction", `Coach said: ${row.body}\nWrong because: ${reason}\nCall context: ${nearby}`);
    }
    res.json(mapSession(sessionRow(row.session_id)));
  });

  app.post("/api/coach/actions/:id/run", async (req, res) => {
    try {
      const actions = await listActions();
      const action = actions.find((item) => item.id === req.params.id && item.enabled);
      if (!action) {
        res.status(404).json({ error: "Action not found." });
        return;
      }
      const session = sessionRow(req.body?.sessionId);
      if (!session) {
        res.status(404).json({ error: "Coach thread not found." });
        return;
      }
      const message = req.body?.messageId ? messageRow(req.body.messageId) : null;
      if (action.effect === "disposition") {
        res.json({ disposition: action.payload.outcome, session: mapSession(session) });
        return;
      }
      if (action.effect === "steer") {
        db.prepare("UPDATE coach_sessions SET pending_steer = ? WHERE id = ?").run(String(action.payload.text || "").slice(0, 500), session.id);
        addMessage(session.id, { kind: "status", speaker: "Coach", body: `Noted: ${action.label}. The coach will use it on the next reply.` });
        res.json({ session: mapSession(sessionRow(session.id)) });
        return;
      }
      if (action.effect === "notepad" || action.effect === "memory") {
        const text = String(action.payload.text || message?.body || "").trim().slice(0, 1000);
        if (!text) {
          res.status(400).json({ error: "There is nothing to save." });
          return;
        }
        if (action.effect === "memory") rememberLine(text, session.lead_id);
        if (action.effect === "notepad") {
          const lead = db.prepare("SELECT id FROM leads WHERE id = ?").get(session.lead_id);
          if (!lead) {
            res.status(404).json({ error: "That lead is not in the database." });
            return;
          }
          const timestamp = nowIso();
          db.prepare(`
            INSERT INTO lead_notes (id, lead_id, body, author, call_log_id, tags, created_at, updated_at)
            VALUES (?, ?, ?, 'coach', '', '', ?, ?)
          `).run(crypto.randomUUID(), session.lead_id, text, timestamp, timestamp);
          const bodies = db.prepare("SELECT body FROM lead_notes WHERE lead_id = ? ORDER BY created_at, rowid").all(session.lead_id).map((row) => row.body);
          db.prepare("UPDATE leads SET notes = ?, updated_at = ? WHERE id = ?").run(bodies.join("\n"), timestamp, session.lead_id);
        }
        addMessage(session.id, { kind: "status", speaker: "Coach", body: action.effect === "memory" ? "Saved to coach memory." : "Added to this lead's notes." });
        res.json({ session: mapSession(sessionRow(session.id)), notepadUpdated: action.effect === "notepad" });
        return;
      }
      if (action.effect === "prompt") {
        const source = message?.body || "";
        const prompt = String(action.payload.prompt || "").replaceAll("{{message}}", source).replaceAll("{{speaker}}", message?.speaker || "").slice(0, 2000);
        addMessage(session.id, { kind: "note", speaker: "Me", body: prompt });
        const send = wantsCoachStream(req) ? openCoachStream(res) : null;
        if (send) send({ type: "start" });
        await coachTurn(session.id, { mode: "note", onEvent: send });
        const updated = mapSession(sessionRow(session.id));
        if (send) {
          send({ type: "done", session: updated });
          res.end();
        } else res.json({ session: updated });
        return;
      }
      if (action.effect === "plugin") {
        await action.run({
          db,
          nowIso,
          session: mapSession(session),
          message: message ? { id: message.id, kind: message.kind, speaker: message.speaker, body: message.body } : null,
          addMessage: (entry) => addMessage(session.id, entry),
          remember: (text) => rememberLine(text, session.lead_id),
        });
        res.json({ session: mapSession(sessionRow(session.id)) });
      }
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.status(500).json({ error: error.message || "The action failed." });
    }
  });
}
