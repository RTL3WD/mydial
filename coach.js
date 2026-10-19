import fs from "fs";
import path from "path";
import crypto from "crypto";
import { attachCoachThread, prepareCoachThread } from "./coach-thread.js";

const PROVIDER_BASES = {
  openai: "https://api.openai.com/v1",
  ollama: "http://127.0.0.1:11434/v1",
  anthropic: "https://api.anthropic.com",
};

export function registerCoach(app, { db, nowIso, getLead, settingValue, putSetting, audioDir }) {
  fs.mkdirSync(audioDir, { recursive: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS coach_sessions (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      call_log_id TEXT,
      paused INTEGER NOT NULL DEFAULT 0,
      review_status TEXT NOT NULL DEFAULT '',
      review_outcome TEXT NOT NULL DEFAULT '',
      review_notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      ended_at TEXT
    );
    CREATE TABLE IF NOT EXISTS coach_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      speaker TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      audio_path TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS coach_corrections (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS playbooks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS coach_docs (
      source_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS coach_vectors (
      source_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      vector TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS coach_memories (
      id TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      lead_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_coach_sessions_lead ON coach_sessions (lead_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_coach_messages_session ON coach_messages (session_id, created_at);
  `);
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS coach_memory_fts USING fts5(body, content='coach_docs', content_rowid='rowid')`);
  } catch (error) {
    console.error("Coach full-text search is unavailable:", error.message);
  }
  prepareCoachThread(db);

  const reviewJobs = new Map();

  function setting(key) {
    return settingValue(key);
  }

  function mapPlaybook(row) {
    if (!row) return null;
    return { id: row.id, name: row.name, body: row.body, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  function mapMessage(row, sibling = {}) {
    const corrections = db.prepare(
      "SELECT id, reason, created_at AS createdAt FROM coach_corrections WHERE message_id = ? ORDER BY created_at"
    ).all(row.id);
    let meta = {};
    try { meta = JSON.parse(row.meta_json || "{}"); } catch { meta = {}; }
    return {
      id: row.id,
      sessionId: row.session_id,
      kind: row.kind,
      speaker: row.speaker,
      body: row.body,
      hasAudio: Boolean(row.audio_path),
      createdAt: row.created_at,
      rating: row.rating || "",
      meta,
      siblingIndex: sibling.siblingIndex || 1,
      siblingCount: sibling.siblingCount || 1,
      siblingIds: sibling.siblingIds || [row.id],
      corrections,
    };
  }

  function mapMessages(sessionId) {
    const rows = db.prepare("SELECT * FROM coach_messages WHERE session_id = ? ORDER BY created_at, rowid").all(sessionId);
    const groups = new Map();
    for (const row of rows) {
      const group = row.sibling_of || row.id;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(row);
    }
    const visible = [];
    const seen = new Set();
    for (const row of rows) {
      const group = row.sibling_of || row.id;
      if (seen.has(group)) continue;
      seen.add(group);
      const members = groups.get(group);
      const active = members.find((item) => item.active) || members[members.length - 1];
      visible.push(mapMessage(active, {
        siblingIndex: members.findIndex((item) => item.id === active.id) + 1,
        siblingCount: members.length,
        siblingIds: members.map((item) => item.id),
      }));
    }
    return visible;
  }

  function mapSession(row) {
    if (!row) return null;
    const lead = db.prepare("SELECT name, company FROM leads WHERE id = ?").get(row.lead_id);
    const root = row.root_id || row.id;
    const branchRows = db.prepare(`
      SELECT id, created_at FROM coach_sessions
      WHERE id = ? OR root_id = ?
      ORDER BY created_at, rowid
    `).all(root, root);
    let side = 0;
    const branches = branchRows.map((item) => ({
      id: item.id,
      createdAt: item.created_at,
      label: item.id === root ? "Original" : `Branch ${side += 1}`,
    }));
    return {
      id: row.id,
      leadId: row.lead_id,
      leadName: lead?.name || "Lead",
      leadCompany: lead?.company || "",
      callLogId: row.call_log_id,
      paused: Boolean(row.paused),
      reviewStatus: row.review_status,
      createdAt: row.created_at,
      endedAt: row.ended_at,
      rootId: root,
      pendingSteer: row.pending_steer || "",
      branches,
      messages: mapMessages(row.id),
    };
  }

  function sessionRow(id) {
    return db.prepare("SELECT * FROM coach_sessions WHERE id = ?").get(id);
  }

  function addMessage(sessionId, { kind, speaker, body, audioPath = "", siblingOf = "", createdAt = "", meta = null, active = 1 }) {
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO coach_messages (id, session_id, kind, speaker, body, audio_path, created_at, sibling_of, active, rating, meta_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)
    `).run(id, sessionId, kind, speaker, body, audioPath, createdAt || nowIso(), siblingOf, active ? 1 : 0, meta ? JSON.stringify(meta) : "");
    if (siblingOf) {
      db.prepare(`
        UPDATE coach_messages
        SET active = CASE WHEN id = ? THEN 1 ELSE 0 END
        WHERE session_id = ? AND (id = ? OR sibling_of = ?)
      `).run(id, sessionId, siblingOf, siblingOf);
    }
    return id;
  }

  function rememberLine(text, leadId) {
    const cleaned = String(text || "").trim().slice(0, 1000);
    if (!cleaned) return;
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO coach_memories (id, body, lead_id, created_at) VALUES (?, ?, ?, ?)").run(id, cleaned, leadId || "", nowIso());
    saveDoc(`memory:${id}`, "memory", cleaned);
  }

  function saveAudio(messageId, audioBase64) {
    if (!audioBase64) return "";
    const buf = Buffer.from(String(audioBase64), "base64");
    if (buf.length < 44 || buf.subarray(0, 4).toString() !== "RIFF") return "";
    const filename = `${messageId}.wav`;
    fs.writeFileSync(path.join(audioDir, filename), buf);
    db.prepare("UPDATE coach_messages SET audio_path = ? WHERE id = ?").run(filename, messageId);
    return filename;
  }

  function rebuildFts() {
    try {
      db.exec("INSERT INTO coach_memory_fts(coach_memory_fts) VALUES('rebuild')");
    } catch (error) {
      console.error("Coach search rebuild failed:", error.message);
    }
  }

  function saveDoc(sourceId, kind, body) {
    const text = String(body || "").trim();
    if (!text) {
      db.prepare("DELETE FROM coach_docs WHERE source_id = ?").run(sourceId);
      db.prepare("DELETE FROM coach_vectors WHERE source_id = ?").run(sourceId);
      rebuildFts();
      return;
    }
    db.prepare(`
      INSERT INTO coach_docs (source_id, kind, body) VALUES (?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET kind = excluded.kind, body = excluded.body
    `).run(sourceId, kind, text);
    rebuildFts();
    void embedDoc(sourceId, kind, text);
  }

  function ftsQuery(text) {
    const words = String(text || "").toLowerCase().match(/[a-z0-9']{3,}/g) || [];
    const unique = [...new Set(words)].slice(0, 8);
    if (!unique.length) return "";
    return unique.map((word) => `"${word.replaceAll('"', "")}"`).join(" OR ");
  }

  function cosine(a, b) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    const length = Math.min(a.length, b.length);
    for (let i = 0; i < length; i += 1) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  async function embed(text) {
    const provider = setting("embedProvider") || "none";
    const model = setting("embedModel");
    if (!provider || provider === "none" || provider === "anthropic" || !model) return null;
    const base = (setting("embedBaseUrl") || PROVIDER_BASES[provider] || "").replace(/\/$/, "");
    const key = setting("embedApiKey") || setting("llmApiKey");
    if (!base) return null;
    if (provider !== "ollama" && !key && !/localhost|127\.0\.0\.1/.test(base)) return null;
    const response = await fetchWithTimeout(`${base}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ model, input: text.slice(0, 6000) }),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const vector = payload.data?.[0]?.embedding || payload.embedding;
    return Array.isArray(vector) ? vector : null;
  }

  async function embedDoc(sourceId, kind, body) {
    try {
      const vector = await embed(body);
      if (!vector) return;
      db.prepare(`
        INSERT INTO coach_vectors (source_id, kind, body, vector) VALUES (?, ?, ?, ?)
        ON CONFLICT(source_id) DO UPDATE SET kind = excluded.kind, body = excluded.body, vector = excluded.vector
      `).run(sourceId, kind, body, JSON.stringify(vector));
    } catch (error) {
      console.error("Coach embedding skipped:", error.message);
    }
  }

  async function retrieve(query) {
    const hits = [];
    const match = ftsQuery(query);
    if (match) {
      try {
        const rows = db.prepare(`
          SELECT d.source_id AS sourceId, d.kind, d.body
          FROM coach_memory_fts
          JOIN coach_docs d ON d.rowid = coach_memory_fts.rowid
          WHERE coach_memory_fts MATCH ?
          LIMIT 6
        `).all(match);
        hits.push(...rows);
      } catch (error) {
        console.error("Coach search skipped:", error.message);
      }
    }
    try {
      const vector = await embed(query);
      if (vector) {
        const ranked = db.prepare("SELECT source_id AS sourceId, kind, body, vector FROM coach_vectors").all()
          .map((row) => ({ ...row, score: cosine(vector, JSON.parse(row.vector)) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 6);
        for (const row of ranked) {
          if (row.score < 0.2) continue;
          if (!hits.some((hit) => hit.sourceId === row.sourceId)) hits.push(row);
        }
      }
    } catch (error) {
      console.error("Coach vector search skipped:", error.message);
    }
    return hits.slice(0, 8);
  }

  function persona() {
    return {
      name: setting("coachName") || "Coach",
      directness: setting("coachDirectness") || "direct",
      product: setting("coachProduct") || "",
      instructions: setting("coachInstructions") || "Coach in the moment. Suggest the next sentence and why. Keep it short enough to read while talking.",
    };
  }

  function leadContext(leadId) {
    const lead = getLead(leadId);
    if (!lead) return "The lead is no longer in the database.";
    const script = lead.script;
    const sections = (script?.sections || []).map((section) => `${section.label}: ${section.text}`).join("\n");
    const objections = (script?.objections || []).map((item) => `${item.label}: ${item.response}`).join("\n");
    const calls = (lead.calls || []).slice(0, 4).map((call) => `${call.outcome} (${call.durationSeconds || 0}s) ${call.notes || ""}`).join("\n");
    return [
      `Lead: ${lead.name}`,
      lead.title ? `Title: ${lead.title}` : "",
      lead.company ? `Company: ${lead.company}` : "",
      lead.email ? `Email: ${lead.email}` : "",
      `Status: ${lead.status}. Attempts: ${lead.attempts}.`,
      lead.notes ? `Notepad: ${lead.notes}` : "",
      script ? `Script ${script.name}:\n${sections.slice(0, 2000)}` : "No campaign script.",
      objections ? `Objections:\n${objections.slice(0, 1500)}` : "",
      calls ? `Past calls with this lead:\n${calls}` : "No earlier calls with this lead.",
    ].filter(Boolean).join("\n");
  }

  function transcript(messages) {
    return messages
      .filter((message) => message.kind === "me" || message.kind === "prospect" || message.kind === "note")
      .map((message) => `${message.kind === "note" ? "Note to coach" : message.speaker}: ${message.body}`)
      .join("\n");
  }

  function clipText(text, limit = 1500) {
    const value = String(text || "");
    if (value.length <= limit) return value;
    return `${value.slice(0, limit)}\n…`;
  }

  function likeTerm(value) {
    const cleaned = String(value || "").trim().slice(0, 80).replaceAll("%", "").replaceAll("_", "");
    return `%${cleaned}%`;
  }

  function modelFor(mode) {
    const provider = setting("llmProvider") || "ollama";
    const stored = mode === "review" ? setting("llmReviewModel") : setting("llmLiveModel");
    if (stored) return stored;
    if (provider === "ollama") return mode === "review" ? "qwen3.5:9b-mlx" : "qwen3.5:4b-mlx";
    return setting("llmModel");
  }

  function modelProblem(model) {
    const provider = setting("llmProvider") || "ollama";
    const key = setting("llmApiKey");
    const base = setting("llmBaseUrl") || PROVIDER_BASES[provider] || "";
    if (!model) return "Choose the coach models on API & Docker. Listening and the transcript still stay here.";
    const local = provider === "ollama" || /localhost|127\.0\.0\.1/.test(base);
    if (!local && !key) return "Add an API key for the chat model on API & Docker. The transcript is saved either way.";
    return "";
  }

  function messageText(message) {
    const content = message?.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) return content.map((part) => part.text || part.content || "").join("\n").trim();
    return "";
  }

  function toOllamaMessages(messages) {
    return messages.map((message) => {
      if (message.role === "tool") {
        return { role: "tool", tool_name: message.tool_name, content: message.content || "" };
      }
      if (message.role === "assistant" && message.tool_calls) {
        return {
          role: "assistant",
          content: message.content || "",
          tool_calls: message.tool_calls.map((call) => ({
            id: call.id,
            function: {
              name: call.function?.name,
              arguments: typeof call.function?.arguments === "string"
                ? JSON.parse(call.function.arguments || "{}")
                : (call.function?.arguments || {}),
            },
          })),
        };
      }
      return { role: message.role, content: typeof message.content === "string" ? message.content : "" };
    });
  }

  function absorbToolCalls(bucket, incoming) {
    incoming.forEach((call, index) => {
      const slot = Number.isInteger(call.index) ? call.index : index;
      if (!bucket[slot]) bucket[slot] = { id: call.id || "", function: { name: "", arguments: "" } };
      const item = bucket[slot];
      if (call.id) item.id = call.id;
      const fn = call.function || {};
      if (fn.name && !item.function.name) item.function.name = fn.name;
      if (typeof fn.arguments === "string") item.function.arguments += fn.arguments;
      else if (fn.arguments && typeof fn.arguments === "object") item.function.arguments = fn.arguments;
    });
  }

  async function readModelStream(response, onPayload) {
    const reader = response.body?.getReader();
    if (!reader) {
      onPayload(await response.json().catch(() => ({})));
      return;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.indexOf("\n");
      while (split >= 0) {
        const line = buffer.slice(0, split).trim();
        buffer = buffer.slice(split + 1);
        split = buffer.indexOf("\n");
        if (!line || line.startsWith("event:") || line.startsWith(":")) continue;
        const data = line.startsWith("data:") ? line.slice(5).trim() : line;
        if (!data || data === "[DONE]") continue;
        try { onPayload(JSON.parse(data)); } catch { /* wait for the next chunk */ }
      }
    }
  }

  async function completeOnce(messages, { model, maxTokens, tools, think, keepAlive, onDelta }) {
    const provider = setting("llmProvider") || "ollama";
    const key = setting("llmApiKey");
    const streaming = typeof onDelta === "function";
    if (provider === "ollama") {
      const origin = (setting("llmBaseUrl") || PROVIDER_BASES.ollama).replace(/\/$/, "").replace(/\/v1$/, "");
      const response = await fetchWithTimeout(`${origin}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: toOllamaMessages(messages),
          tools: tools || undefined,
          think: false,
          stream: streaming,
          keep_alive: keepAlive,
          options: { temperature: 0.4, num_predict: maxTokens },
        }),
      }, streaming ? 90000 : 45000);
      if (!streaming) {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || "The chat model rejected the request.");
        const message = payload.message || {};
        return {
          content: message.content || "",
          tool_calls: (message.tool_calls || []).map((call) => ({
            id: call.id,
            function: { name: call.function?.name, arguments: call.function?.arguments || {} },
          })),
        };
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "The chat model rejected the request.");
      }
      let content = "";
      const toolCalls = [];
      let streamError = "";
      await readModelStream(response, (payload) => {
        if (payload.error) streamError = typeof payload.error === "string" ? payload.error : "The chat model rejected the request.";
        const message = payload.message || {};
        if (message.content) {
          content += message.content;
          onDelta(message.content);
        }
        if (Array.isArray(message.tool_calls) && message.tool_calls.length) absorbToolCalls(toolCalls, message.tool_calls);
      });
      if (streamError) throw new Error(streamError);
      return { content, tool_calls: toolCalls.filter((call) => call?.function?.name) };
    }
    if (provider === "anthropic") {
      const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
      const response = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system,
          stream: streaming,
          messages: anthropicMessages(messages),
        }),
      }, streaming ? 90000 : 45000);
      if (!streaming) {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error?.message || "The Anthropic model rejected the request.");
        return { content: payload.content?.map((part) => part.text || "").join("\n").trim() || "" };
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error?.message || "The Anthropic model rejected the request.");
      }
      let content = "";
      await readModelStream(response, (payload) => {
        const text = payload.delta?.text || "";
        if (payload.type === "content_block_delta" && text) {
          content += text;
          onDelta(text);
        }
      });
      return { content };
    }
    const base = (setting("llmBaseUrl") || PROVIDER_BASES[provider] || "").replace(/\/$/, "");
    if (!base) throw new Error("Add a base URL for this chat model.");
    const body = { model, temperature: 0.4, max_tokens: maxTokens, messages };
    if (tools) body.tools = tools;
    if (streaming) body.stream = true;
    const response = await fetchWithTimeout(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
    }, streaming ? 90000 : 45000);
    if (!streaming) {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || "The chat model rejected the request.");
      return payload.choices?.[0]?.message || { content: "" };
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error?.message || "The chat model rejected the request.");
    }
    let content = "";
    const toolCalls = [];
    await readModelStream(response, (payload) => {
      const delta = payload.choices?.[0]?.delta || {};
      if (delta.content) {
        content += delta.content;
        onDelta(delta.content);
      }
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) absorbToolCalls(toolCalls, delta.tool_calls);
    });
    return { content, tool_calls: toolCalls.filter((call) => call?.function?.name) };
  }

  function toolSpec(name, description, properties, required) {
    return {
      type: "function",
      function: {
        name,
        description,
        parameters: { type: "object", properties, required },
      },
    };
  }

  function toolList(mode) {
    const tools = [
      toolSpec("search_leads", "Find leads by name, company, phone, or email. Leave query blank to list recent leads.", { query: { type: "string" } }, []),
      toolSpec("get_lead", "Read one lead, including recent call outcomes.", { id: { type: "string" } }, ["id"]),
      toolSpec("recent_calls", "List recent calls. Pass a lead id to limit the list to that lead.", { leadId: { type: "string" } }, []),
      toolSpec("list_scripts", "List call script names.", {}, []),
      toolSpec("get_script", "Read one script, including sections and objections.", { id: { type: "string" } }, ["id"]),
      toolSpec("list_campaigns", "List campaigns with status and how many leads are queued.", {}, []),
      toolSpec("search_inbox", "Search email subjects and bodies.", { query: { type: "string" } }, ["query"]),
      toolSpec("queue_snapshot", "Say how many leads are queued and name the next few.", {}, []),
      toolSpec("search_memory", "Search playbooks, reviews, corrections, and coach memory.", { query: { type: "string" } }, ["query"]),
      toolSpec("remember", "Save a fact the coach should recall on later calls, including other leads.", { text: { type: "string" } }, ["text"]),
    ];
    if (mode === "note") {
      tools.push(toolSpec(
        "append_notepad",
        "Append one line to the current lead's notepad. Use only when the typed note asks to save something there. This does not change status, queue, phone, or disposition.",
        { text: { type: "string" } },
        ["text"],
      ));
    }
    return tools;
  }

  function recentMemoryText() {
    const rows = db.prepare("SELECT body FROM coach_memories ORDER BY created_at DESC LIMIT 5").all().reverse();
    return rows.map((row) => row.body).join("\n");
  }

  function runTool(name, args, { leadId, effects }) {
    const input = args && typeof args === "object" ? args : {};
    if (name === "search_leads") {
      const query = String(input.query || "").trim();
      const term = likeTerm(query);
      const rows = query
        ? db.prepare(`
          SELECT id, name, company, phone, email, status, attempts
          FROM leads
          WHERE name LIKE ? OR company LIKE ? OR phone LIKE ? OR email LIKE ?
          ORDER BY updated_at DESC
          LIMIT 8
        `).all(term, term, term, term)
        : db.prepare(`
          SELECT id, name, company, phone, email, status, attempts
          FROM leads
          ORDER BY updated_at DESC
          LIMIT 8
        `).all();
      if (!rows.length) return "No leads matched.";
      return rows.map((row) => `${row.name} | ${row.company || "no company"} | ${row.phone} | ${row.status} | attempts ${row.attempts} | id ${row.id}`).join("\n");
    }
    if (name === "get_lead") {
      const lead = getLead(String(input.id || leadId || ""));
      if (!lead) return "That lead is not in the database.";
      const calls = (lead.calls || []).slice(0, 4).map((call) => `${call.outcome} ${call.durationSeconds || 0}s ${call.notes || ""}`.trim()).join("; ");
      return [
        `${lead.name} | ${lead.company || "no company"} | ${lead.phone} | ${lead.email || "no email"}`,
        `Status ${lead.status}. Attempts ${lead.attempts}.`,
        lead.notes ? `Notepad: ${clipText(lead.notes, 400)}` : "Notepad is empty.",
        calls ? `Recent calls: ${calls}` : "No calls logged.",
      ].join("\n");
    }
    if (name === "recent_calls") {
      const id = String(input.leadId || "").trim();
      const rows = id
        ? db.prepare("SELECT lead_name, outcome, duration_seconds, notes, ended_at FROM call_logs WHERE lead_id = ? ORDER BY ended_at DESC LIMIT 8").all(id)
        : db.prepare("SELECT lead_name, outcome, duration_seconds, notes, ended_at FROM call_logs ORDER BY ended_at DESC LIMIT 8").all();
      if (!rows.length) return "No calls logged.";
      return rows.map((row) => `${row.ended_at} | ${row.lead_name} | ${row.outcome} | ${row.duration_seconds}s | ${clipText(row.notes, 160)}`).join("\n");
    }
    if (name === "list_scripts") {
      const rows = db.prepare("SELECT id, name FROM scripts ORDER BY name LIMIT 20").all();
      if (!rows.length) return "No scripts saved.";
      return rows.map((row) => `${row.name} | id ${row.id}`).join("\n");
    }
    if (name === "get_script") {
      const row = db.prepare("SELECT * FROM scripts WHERE id = ?").get(String(input.id || ""));
      if (!row) return "That script is not in the database.";
      const objections = db.prepare("SELECT label, response FROM objections WHERE script_id = ? ORDER BY sort_order, label").all(row.id);
      let sections = "";
      try {
        const parsed = JSON.parse(row.sections_json || "[]");
        if (Array.isArray(parsed)) sections = parsed.map((section) => `${section.label}: ${section.text}`).join("\n");
      } catch { /* body fallback */ }
      return [`Script ${row.name}`, clipText(sections || row.body, 900), objections.length ? `Objections:\n${objections.map((item) => `${item.label}: ${item.response}`).join("\n")}` : ""].filter(Boolean).join("\n");
    }
    if (name === "list_campaigns") {
      const rows = db.prepare(`
        SELECT campaigns.id, campaigns.name, campaigns.status,
          (SELECT COUNT(*) FROM leads WHERE leads.campaign_id = campaigns.id AND leads.in_queue = 1 AND leads.archived = 0) AS queued
        FROM campaigns
        ORDER BY campaigns.name
        LIMIT 20
      `).all();
      if (!rows.length) return "No campaigns saved.";
      return rows.map((row) => `${row.name} | ${row.status} | ${row.queued} queued | id ${row.id}`).join("\n");
    }
    if (name === "search_inbox") {
      const query = String(input.query || "").trim();
      if (!query) return "Say what to search for.";
      const term = likeTerm(query);
      const rows = db.prepare(`
        SELECT emails.subject, emails.body, emails.direction, emails.status
        FROM emails
        LEFT JOIN email_threads ON email_threads.id = emails.thread_id
        WHERE emails.subject LIKE ? OR emails.body LIKE ? OR email_threads.subject LIKE ?
        ORDER BY emails.created_at DESC
        LIMIT 6
      `).all(term, term, term);
      if (!rows.length) return "No emails matched.";
      return rows.map((row) => `${row.direction} | ${row.status} | ${row.subject} | ${clipText(row.body, 180)}`).join("\n");
    }
    if (name === "queue_snapshot") {
      const count = db.prepare("SELECT COUNT(*) AS count FROM leads WHERE in_queue = 1 AND archived = 0").get().count;
      const rows = db.prepare("SELECT name, company FROM leads WHERE in_queue = 1 AND archived = 0 ORDER BY queue_order ASC LIMIT 5").all();
      const names = rows.map((row) => row.company ? `${row.name} (${row.company})` : row.name).join(", ");
      return `${count} queued.${names ? ` Next: ${names}.` : ""}`;
    }
    if (name === "remember") {
      const text = String(input.text || "").trim().slice(0, 1000);
      if (!text) return "Nothing to remember.";
      const id = crypto.randomUUID();
      db.prepare("INSERT INTO coach_memories (id, body, lead_id, created_at) VALUES (?, ?, ?, ?)").run(id, text, leadId || "", nowIso());
      saveDoc(`memory:${id}`, "memory", text);
      return "Saved to coach memory.";
    }
    if (name === "append_notepad") {
      if (!leadId) return "There is no current lead.";
      const line = String(input.text || "").replace(/\s+/g, " ").trim().slice(0, 500);
      if (!line) return "Nothing to add.";
      const lead = db.prepare("SELECT id FROM leads WHERE id = ?").get(leadId);
      if (!lead) return "That lead is not in the database.";
      const timestamp = nowIso();
      db.prepare(`
        INSERT INTO lead_notes (id, lead_id, body, author, call_log_id, tags, created_at, updated_at)
        VALUES (?, ?, ?, 'coach', '', '', ?, ?)
      `).run(crypto.randomUUID(), leadId, line, timestamp, timestamp);
      const bodies = db.prepare("SELECT body FROM lead_notes WHERE lead_id = ? ORDER BY created_at, rowid").all(leadId).map((row) => row.body);
      db.prepare("UPDATE leads SET notes = ?, updated_at = ? WHERE id = ?").run(bodies.join("\n"), timestamp, leadId);
      if (effects) effects.notepadUpdated = true;
      return "Added to this lead's notes.";
    }
    return "That tool is not available.";
  }

  async function chatComplete(messages, { mode = "turn", leadId = "", effects = null, onEvent = null } = {}) {
    const model = modelFor(mode);
    const problem = modelProblem(model);
    if (problem) throw new Error(problem);
    const provider = setting("llmProvider") || "ollama";
    const limits = { turn: 180, note: 400, review: 700 };
    const maxTokens = limits[mode] || 400;
    const keepAlive = mode === "review" ? "2m" : "30m";
    const tools = mode === "turn" || provider === "anthropic" ? null : toolList(mode);
    const emit = (event) => {
      try { onEvent?.(event); } catch { /* the browser can leave mid-reply */ }
    };
    const streamedOnce = async (input, toolsForRound) => {
      let sent = false;
      const message = await completeOnce(input, {
        model,
        maxTokens,
        tools: toolsForRound,
        think: false,
        keepAlive,
        onDelta: onEvent
          ? (text) => {
            if (!text) return;
            sent = true;
            emit({ type: "delta", text });
          }
          : undefined,
      });
      return { message, sent };
    };
    if (!tools) {
      const { message } = await streamedOnce(messages, null);
      return { text: messageText(message), toolsUsed: [] };
    }
    const convo = messages.map((message) => ({ ...message }));
    const toolsUsed = [];
    for (let round = 0; round < 3; round += 1) {
      const { message, sent } = await streamedOnce(convo, round < 2 ? tools : null);
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (!calls.length) return { text: messageText(message), toolsUsed };
      if (sent) emit({ type: "reset" });
      emit({ type: "status", body: "Looking that up…" });
      convo.push({ role: "assistant", content: messageText(message), tool_calls: calls });
      for (const call of calls) {
        const name = call.function?.name || "";
        let args = call.function?.arguments || {};
        if (typeof args === "string") {
          try { args = JSON.parse(args || "{}"); } catch { args = {}; }
        }
        toolsUsed.push(name);
        let result = "The tool failed.";
        try {
          result = name === "search_memory"
            ? await memoryToolResult(String(args.query || ""))
            : runTool(name, args, { leadId, effects });
        } catch (error) {
          result = error.message;
        }
        convo.push({ role: "tool", tool_name: name, tool_call_id: call.id || name, content: clipText(result) });
      }
    }
    return { text: "", toolsUsed };
  }

  async function memoryToolResult(query) {
    const hits = await retrieve(query);
    if (!hits.length) return "Nothing in memory matched.";
    return hits.map((hit) => `(${hit.kind}) ${hit.body}`).join("\n---\n");
  }

  async function transcribeRemote(buffer) {
    const model = setting("sttModel") || "whisper-1";
    const base = (setting("sttBaseUrl") || PROVIDER_BASES.openai).replace(/\/$/, "");
    const key = setting("sttApiKey") || setting("llmApiKey");
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: "audio/wav" }), "clip.wav");
    form.append("model", model);
    const response = await fetchWithTimeout(`${base}/audio/transcriptions`, {
      method: "POST",
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      body: form,
    }, 60000);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error?.message || "Transcription was rejected.");
    return String(payload.text || "").trim();
  }

  function looksLikePersonaChange(text) {
    return /\b(be more|be less|more direct|less direct|from now on|your name is|call yourself|don't mention|do not mention|sound more|talk like|keep it|persona|shorter|warmer|tougher)\b/i.test(text);
  }

  function fitInstructions(text) {
    const limit = 2000;
    if (text.length <= limit) return text;
    const lines = text.split("\n");
    while (lines.length > 1 && lines.join("\n").length > limit) lines.shift();
    let fitted = lines.join("\n");
    if (fitted.length > limit) fitted = fitted.slice(fitted.length - limit).trimStart();
    return fitted.trim();
  }

  function rememberPersona(text) {
    const previous = setting("coachInstructions");
    const next = previous ? `${previous}\n${text}` : text;
    putSetting("coachInstructions", fitInstructions(next));
  }

  async function coachTurn(sessionId, { mode = "turn", outcome = "", notes = "", effects = null, onEvent = null, noteId = "", untilMessageId = "", siblingOf = "", siblingCreatedAt = "", continueBody = "", returnText = false } = {}) {
    const row = sessionRow(sessionId);
    if (!row) return null;
    const current = mapSession(row);
    if (untilMessageId) {
      const until = db.prepare("SELECT created_at FROM coach_messages WHERE id = ?").get(untilMessageId);
      if (until) current.messages = current.messages.filter((message) => message.createdAt < until.created_at);
    }
    const spoken = current.messages.filter((message) => message.kind === "prospect" || message.kind === "note").map((message) => message.body).join(" ");
    const lessons = await retrieve(`${spoken}\n${current.leadCompany}\n${outcome}`);
    const lessonText = lessons.length
      ? lessons.map((hit) => `(${hit.kind}) ${hit.body}`).join("\n---\n")
      : "No saved playbook sections, reviews, or corrections matched this call.";
    const memoryText = recentMemoryText();
    const profile = persona();
    const task = mode === "review"
      ? "Write the post-call review. Cover what went well and what to change next time. No scores or percentages. Use short paragraphs. You may look up the database and save a memory. Do not change the lead."
      : mode === "continue"
        ? "Continue the coach reply. Do not repeat sentences already written. Add one to three sentences."
      : mode === "note"
        ? "Answer only the latest note. If the transcript has no prospect lines yet, this is pre-call prep: help Me plan the opener, the angle, and the objections to expect for this lead. Look up the database when that note depends on leads, calls, scripts, campaigns, inbox, the queue, or memory. If it asks to add or save something on the notepad, call append_notepad before you answer. If it asks you to remember a fact for later calls, call remember before you answer. Do not say you saved anything unless the tool result says you did. Once a prospect has spoken, add what to say next."
        : "The prospect just finished a turn. In 2 to 4 sentences, say what Me should say next and why. Do not call tools.";
    const system = [
      `You are ${profile.name}, a live sales coach sitting beside the caller.`,
      `Directness: ${profile.directness}.`,
      profile.product ? `What they sell: ${profile.product}.` : "",
      `Standing instructions:\n${profile.instructions}`,
      "The caller is labeled Me. Everyone else uses the speaker name in the transcript.",
      "Do not invent scores, win rates, or facts that are not in the context or in a tool result.",
      "Do not speak as if you are on the phone. Write to Me.",
      task,
      row.pending_steer ? `Direction Me just signaled. Apply it in this reply, and do not mention that a button was clicked:\n${row.pending_steer}` : "",
      `Lead and script:\n${leadContext(row.lead_id)}`,
      memoryText ? `Recent coach memory:\n${memoryText}` : "",
      `Retrieved playbooks, reviews, and corrections:\n${lessonText}`,
    ].filter(Boolean).join("\n\n");
    const conversation = [{ role: "system", content: system }];
    const lines = transcript(current.messages);
    const focusedNote = noteId ? current.messages.find((message) => message.id === noteId) : null;
    if (mode === "continue") {
      conversation.push({ role: "user", content: `Coach reply so far:\n${continueBody}` });
    } else if (mode === "review") {
      conversation.push({
        role: "user",
        content: `The call is over. Outcome: ${outcome || "unspecified"}. Notepad: ${notes || "empty"}.\n\nTranscript:\n${lines || "(no transcript)"}`,
      });
    } else if (mode === "note") {
      const latest = focusedNote || [...current.messages].reverse().find((message) => message.kind === "note");
      conversation.push({
        role: "user",
        content: `Transcript:\n${lines || "(no transcript)"}\n\nLatest note to answer:\n${latest?.body || ""}`,
      });
    } else if (lines) {
      conversation.push({ role: "user", content: lines });
    }
    let body;
    let answered = false;
    let toolsUsed = [];
    const started = Date.now();
    try {
      const result = await chatComplete(conversation, { mode: mode === "continue" ? "note" : mode, leadId: row.lead_id, effects, onEvent });
      body = result.text;
      toolsUsed = result.toolsUsed;
      answered = true;
      if (!body) body = "The model returned an empty note.";
    } catch (error) {
      body = error.message;
    }
    const meta = { model: modelFor(mode === "continue" ? "note" : mode), ms: Date.now() - started, tools: toolsUsed };
    if (row.pending_steer) db.prepare("UPDATE coach_sessions SET pending_steer = '' WHERE id = ?").run(sessionId);
    if (returnText) return { body, meta };
    if (toolsUsed.length && !siblingOf) {
      addMessage(sessionId, { kind: "status", speaker: "Coach", body: `Used ${toolsUsed.join(", ")}.` });
    }
    addMessage(sessionId, {
      kind: mode === "review" ? "review" : "coach",
      speaker: profile.name,
      body,
      siblingOf,
      createdAt: siblingCreatedAt,
      meta,
    });
    if (mode === "review" && answered) {
      const reviewId = db.prepare("SELECT id FROM coach_messages WHERE session_id = ? AND kind = 'review' ORDER BY created_at DESC LIMIT 1").get(sessionId)?.id;
      if (reviewId) saveDoc(`review:${reviewId}`, "review", `${current.leadName}: ${body}`);
    }
    return mapSession(sessionRow(sessionId));
  }

  async function writeReview(sessionId) {
    const row = sessionRow(sessionId);
    if (!row || row.review_status === "done") return mapSession(row);
    db.prepare("UPDATE coach_sessions SET review_status = 'pending' WHERE id = ?").run(sessionId);
    try {
      await coachTurn(sessionId, { mode: "review", outcome: row.review_outcome, notes: row.review_notes });
      db.prepare("UPDATE coach_sessions SET review_status = 'done' WHERE id = ?").run(sessionId);
    } catch (error) {
      db.prepare("UPDATE coach_sessions SET review_status = 'failed' WHERE id = ?").run(sessionId);
      addMessage(sessionId, { kind: "status", speaker: "Coach", body: error.message });
    }
    return mapSession(sessionRow(sessionId));
  }

  function scheduleReview(sessionId, delayMs) {
    const existing = reviewJobs.get(sessionId);
    if (existing?.started) return;
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      const job = reviewJobs.get(sessionId);
      if (!job || job.started) return;
      job.started = true;
      void writeReview(sessionId);
    }, delayMs);
    reviewJobs.set(sessionId, { timer, started: false });
  }

  function reviewAfterDisposition({ leadId, callLogId, outcome, notes }) {
    const row = db.prepare(`
      SELECT * FROM coach_sessions
      WHERE lead_id = ? AND ended_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `).get(leadId);
    if (!row) return;
    const endedAt = nowIso();
    db.prepare(`
      UPDATE coach_sessions
      SET call_log_id = ?, ended_at = ?, review_status = 'pending', review_outcome = ?, review_notes = ?
      WHERE id = ?
    `).run(callLogId || null, endedAt, outcome || "", notes || "", row.id);
    scheduleReview(row.id, 12000);
  }

  function deleteSessionRecord(sessionId) {
    const messages = db.prepare("SELECT id, audio_path FROM coach_messages WHERE session_id = ?").all(sessionId);
    for (const message of messages) {
      const corrections = db.prepare("SELECT id FROM coach_corrections WHERE message_id = ?").all(message.id);
      for (const correction of corrections) {
        db.prepare("DELETE FROM coach_docs WHERE source_id = ?").run(`correction:${correction.id}`);
        db.prepare("DELETE FROM coach_vectors WHERE source_id = ?").run(`correction:${correction.id}`);
      }
      db.prepare("DELETE FROM coach_corrections WHERE message_id = ?").run(message.id);
      db.prepare("DELETE FROM coach_docs WHERE source_id = ?").run(`review:${message.id}`);
      db.prepare("DELETE FROM coach_vectors WHERE source_id = ?").run(`review:${message.id}`);
      if (message.audio_path) {
        fs.rmSync(path.join(audioDir, path.basename(message.audio_path)), { force: true });
      }
    }
    db.prepare("DELETE FROM coach_messages WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM coach_sessions WHERE id = ?").run(sessionId);
  }

  function deleteLeadCoach(leadId) {
    const sessions = db.prepare("SELECT id FROM coach_sessions WHERE lead_id = ?").all(leadId);
    for (const session of sessions) deleteSessionRecord(session.id);
    rebuildFts();
  }

  app.get("/api/playbooks", (_req, res) => {
    res.json(db.prepare("SELECT * FROM playbooks ORDER BY updated_at DESC").all().map(mapPlaybook));
  });

  app.post("/api/playbooks", (req, res) => {
    const name = String(req.body?.name || "").trim();
    const body = String(req.body?.body || "");
    if (!name) {
      res.status(400).json({ error: "Name the playbook." });
      return;
    }
    const id = crypto.randomUUID();
    const timestamp = nowIso();
    db.prepare("INSERT INTO playbooks (id, name, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, name, body, timestamp, timestamp);
    saveDoc(`playbook:${id}`, "playbook", `${name}\n${body}`);
    res.status(201).json(mapPlaybook(db.prepare("SELECT * FROM playbooks WHERE id = ?").get(id)));
  });

  app.patch("/api/playbooks/:id", (req, res) => {
    const existing = db.prepare("SELECT * FROM playbooks WHERE id = ?").get(req.params.id);
    if (!existing) {
      res.status(404).json({ error: "Playbook not found." });
      return;
    }
    const name = req.body?.name !== undefined ? String(req.body.name).trim() : existing.name;
    const body = req.body?.body !== undefined ? String(req.body.body) : existing.body;
    if (!name) {
      res.status(400).json({ error: "Name the playbook." });
      return;
    }
    db.prepare("UPDATE playbooks SET name = ?, body = ?, updated_at = ? WHERE id = ?").run(name, body, nowIso(), existing.id);
    saveDoc(`playbook:${existing.id}`, "playbook", `${name}\n${body}`);
    res.json(mapPlaybook(db.prepare("SELECT * FROM playbooks WHERE id = ?").get(existing.id)));
  });

  app.delete("/api/playbooks/:id", (req, res) => {
    const existing = db.prepare("SELECT * FROM playbooks WHERE id = ?").get(req.params.id);
    if (!existing) {
      res.status(404).json({ error: "Playbook not found." });
      return;
    }
    db.prepare("DELETE FROM playbooks WHERE id = ?").run(existing.id);
    saveDoc(`playbook:${existing.id}`, "playbook", "");
    res.json({ id: existing.id });
  });

  app.post("/api/coach/sessions", (req, res) => {
    const lead = getLead(req.body?.leadId);
    if (!lead) {
      res.status(404).json({ error: "Lead not found." });
      return;
    }
    const open = db.prepare(`
      SELECT * FROM coach_sessions
      WHERE lead_id = ? AND ended_at IS NULL AND (root_id = '' OR root_id = id)
      ORDER BY created_at DESC LIMIT 1
    `).get(lead.id);
    if (open) {
      res.json(mapSession(open));
      return;
    }
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO coach_sessions (id, lead_id, root_id, created_at) VALUES (?, ?, ?, ?)").run(id, lead.id, id, nowIso());
    res.status(201).json(mapSession(sessionRow(id)));
  });

  app.post("/api/coach/sessions/:id/reset", (req, res) => {
    const row = sessionRow(req.params.id);
    if (!row) {
      res.status(404).json({ error: "Coach thread not found." });
      return;
    }
    const root = row.root_id || row.id;
    const family = db.prepare("SELECT id FROM coach_sessions WHERE id = ? OR root_id = ?").all(root, root);
    for (const session of family) {
      const job = reviewJobs.get(session.id);
      if (job) clearTimeout(job.timer);
      reviewJobs.delete(session.id);
      deleteSessionRecord(session.id);
    }
    rebuildFts();
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO coach_sessions (id, lead_id, root_id, created_at) VALUES (?, ?, ?, ?)").run(id, row.lead_id, id, nowIso());
    res.status(201).json(mapSession(sessionRow(id)));
  });

  app.get("/api/coach/sessions/:id", (req, res) => {
    const row = sessionRow(req.params.id);
    if (!row) {
      res.status(404).json({ error: "Coach thread not found." });
      return;
    }
    res.json(mapSession(row));
  });

  app.get("/api/coach/leads/:id/open", (req, res) => {
    const row = db.prepare(`
      SELECT * FROM coach_sessions
      WHERE lead_id = ? AND ended_at IS NULL AND (root_id = '' OR root_id = id)
      ORDER BY created_at DESC LIMIT 1
    `).get(req.params.id);
    res.json({ session: mapSession(row) });
  });

  app.get("/api/coach/calls/:callLogId", (req, res) => {
    const row = db.prepare("SELECT * FROM coach_sessions WHERE call_log_id = ?").get(req.params.callLogId);
    if (!row) {
      res.status(404).json({ error: "No coach thread for that call." });
      return;
    }
    res.json(mapSession(row));
  });

  app.patch("/api/coach/sessions/:id", (req, res) => {
    const row = sessionRow(req.params.id);
    if (!row) {
      res.status(404).json({ error: "Coach thread not found." });
      return;
    }
    if (req.body?.paused !== undefined) {
      db.prepare("UPDATE coach_sessions SET paused = ? WHERE id = ?").run(req.body.paused ? 1 : 0, row.id);
    }
    res.json(mapSession(sessionRow(row.id)));
  });

  function wantsCoachStream(req) {
    return String(req.headers.accept || "").includes("text/event-stream") || req.body?.stream === true;
  }

  function openCoachStream(res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    res.socket?.setNoDelay?.(true);
    return (event) => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
  }

  app.post("/api/coach/sessions/:id/utterances", async (req, res) => {
    try {
    const row = sessionRow(req.params.id);
    if (!row) {
      res.status(404).json({ error: "Coach thread not found." });
      return;
    }
    if (row.ended_at) {
      res.status(400).json({ error: "This call's coach thread is already closed." });
      return;
    }
    const speaker = String(req.body?.speaker || "Prospect").trim().slice(0, 40) || "Prospect";
    let text = String(req.body?.text || "").trim();
    const messageId = addMessage(row.id, {
      kind: speaker.toLowerCase() === "me" ? "me" : "prospect",
      speaker,
      body: text || "…",
    });
    const filename = saveAudio(messageId, req.body?.audioBase64);
    if (!text && filename && (setting("sttMode") || "local") === "remote") {
      try {
        text = await transcribeRemote(fs.readFileSync(path.join(audioDir, filename)));
      } catch (error) {
        text = "";
        addMessage(row.id, { kind: "status", speaker: "Coach", body: error.message });
      }
    }
    db.prepare("UPDATE coach_messages SET body = ? WHERE id = ?").run(text || "(no words recognized)", messageId);
    const isProspect = speaker.toLowerCase() !== "me";
    const reply = isProspect && text && !row.paused;
    if (!wantsCoachStream(req)) {
      if (reply) await coachTurn(row.id);
      res.json(mapSession(sessionRow(row.id)));
      return;
    }
    const send = openCoachStream(res);
    if (reply) {
      send({ type: "start" });
      await coachTurn(row.id, { onEvent: send });
    }
    send({ type: "done", session: mapSession(sessionRow(row.id)) });
    res.end();
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.status(500).json({ error: "The coach could not save that line." });
      else if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: "error", error: "The coach could not save that line." })}\n\n`);
        res.end();
      }
    }
  });

  app.post("/api/coach/sessions/:id/notes", async (req, res) => {
    try {
    const row = sessionRow(req.params.id);
    if (!row) {
      res.status(404).json({ error: "Coach thread not found." });
      return;
    }
    const text = String(req.body?.text || "").trim();
    if (!text) {
      res.status(400).json({ error: "Write a note to the coach." });
      return;
    }
    addMessage(row.id, { kind: "note", speaker: "Me", body: text.slice(0, 4000) });
    let personaUpdated = false;
    if (looksLikePersonaChange(text)) {
      rememberPersona(text.slice(0, 500));
      personaUpdated = true;
    }
    const effects = { notepadUpdated: false };
    if (!wantsCoachStream(req)) {
      if (!row.paused) await coachTurn(row.id, { mode: "note", effects });
      const session = mapSession(sessionRow(row.id));
      res.json({ ...session, personaUpdated, notepadUpdated: effects.notepadUpdated });
      return;
    }
    const send = openCoachStream(res);
    send({ type: "start" });
    if (!row.paused) await coachTurn(row.id, { mode: "note", effects, onEvent: send });
    send({
      type: "done",
      session: mapSession(sessionRow(row.id)),
      personaUpdated,
      notepadUpdated: effects.notepadUpdated,
    });
    res.end();
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.status(500).json({ error: "The coach could not answer that note." });
      else if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: "error", error: "The coach could not answer that note." })}\n\n`);
        res.end();
      }
    }
  });

  app.post("/api/coach/sessions/:id/finish", (req, res) => {
    const row = sessionRow(req.params.id);
    if (!row) {
      res.status(404).json({ error: "Coach thread not found." });
      return;
    }
    if (row.review_status === "pending") scheduleReview(row.id, 0);
    res.json(mapSession(sessionRow(row.id)));
  });

  app.patch("/api/coach/messages/:id", (req, res) => {
    const message = db.prepare("SELECT * FROM coach_messages WHERE id = ?").get(req.params.id);
    if (!message) {
      res.status(404).json({ error: "Line not found." });
      return;
    }
    const speaker = String(req.body?.speaker || "").trim().slice(0, 40);
    if (!speaker) {
      res.status(400).json({ error: "Name the speaker." });
      return;
    }
    const kind = speaker.toLowerCase() === "me" ? "me" : (message.kind === "me" || message.kind === "prospect" ? "prospect" : message.kind);
    db.prepare("UPDATE coach_messages SET speaker = ?, kind = ? WHERE id = ?").run(speaker, kind, message.id);
    res.json(mapSession(sessionRow(message.session_id)));
  });

  app.post("/api/coach/messages/:id/wrong", (req, res) => {
    const message = db.prepare("SELECT * FROM coach_messages WHERE id = ?").get(req.params.id);
    if (!message || (message.kind !== "coach" && message.kind !== "review")) {
      res.status(404).json({ error: "That note cannot be marked wrong." });
      return;
    }
    const reason = String(req.body?.reason || "").trim();
    if (!reason) {
      res.status(400).json({ error: "Say what was wrong." });
      return;
    }
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO coach_corrections (id, message_id, reason, created_at) VALUES (?, ?, ?, ?)").run(id, message.id, reason.slice(0, 2000), nowIso());
    const session = mapSession(sessionRow(message.session_id));
    const nearby = session.messages.filter((item) => item.kind === "prospect" || item.kind === "me").slice(-4)
      .map((item) => `${item.speaker}: ${item.body}`).join(" ");
    saveDoc(`correction:${id}`, "correction", `Coach said: ${message.body}\nWrong because: ${reason}\nCall context: ${nearby}`);
    res.json(mapSession(sessionRow(message.session_id)));
  });

  app.get("/api/coach/audio/:messageId", (req, res) => {
    const message = db.prepare("SELECT audio_path FROM coach_messages WHERE id = ?").get(req.params.messageId);
    if (!message?.audio_path) {
      res.status(404).json({ error: "No audio for that line." });
      return;
    }
    const full = path.join(audioDir, path.basename(message.audio_path));
    if (!fs.existsSync(full)) {
      res.status(404).json({ error: "Audio file is missing." });
      return;
    }
    res.type("audio/wav");
    fs.createReadStream(full).pipe(res);
  });

  attachCoachThread(app, {
    db,
    nowIso,
    sessionRow,
    mapSession,
    coachTurn,
    addMessage,
    saveDoc,
    rememberLine,
    openCoachStream,
    wantsCoachStream,
  });

  return { reviewAfterDisposition, deleteLeadCoach };
}

function anthropicMessages(messages) {
  const rows = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    const last = rows.at(-1);
    if (last && last.role === role) last.content += `\n${message.content}`;
    else rows.push({ role, content: message.content });
  }
  if (!rows.length || rows[0].role !== "user") rows.unshift({ role: "user", content: "The call is starting." });
  return rows;
}

async function fetchWithTimeout(url, options, ms = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") throw new Error("The model took too long to answer.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
