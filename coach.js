import fs from "fs";
import path from "path";
import crypto from "crypto";

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
    CREATE INDEX IF NOT EXISTS idx_coach_sessions_lead ON coach_sessions (lead_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_coach_messages_session ON coach_messages (session_id, created_at);
  `);
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS coach_memory_fts USING fts5(body, content='coach_docs', content_rowid='rowid')`);
  } catch (error) {
    console.error("Coach full-text search is unavailable:", error.message);
  }

  const reviewJobs = new Map();

  function setting(key) {
    return settingValue(key);
  }

  function mapPlaybook(row) {
    if (!row) return null;
    return { id: row.id, name: row.name, body: row.body, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  function mapMessage(row) {
    const corrections = db.prepare(
      "SELECT id, reason, created_at AS createdAt FROM coach_corrections WHERE message_id = ? ORDER BY created_at"
    ).all(row.id);
    return {
      id: row.id,
      sessionId: row.session_id,
      kind: row.kind,
      speaker: row.speaker,
      body: row.body,
      hasAudio: Boolean(row.audio_path),
      createdAt: row.created_at,
      corrections,
    };
  }

  function mapSession(row) {
    if (!row) return null;
    const lead = db.prepare("SELECT name, company FROM leads WHERE id = ?").get(row.lead_id);
    const messages = db.prepare("SELECT * FROM coach_messages WHERE session_id = ? ORDER BY created_at, rowid").all(row.id).map(mapMessage);
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
      messages,
    };
  }

  function sessionRow(id) {
    return db.prepare("SELECT * FROM coach_sessions WHERE id = ?").get(id);
  }

  function addMessage(sessionId, { kind, speaker, body, audioPath = "" }) {
    const id = crypto.randomUUID();
    const createdAt = nowIso();
    db.prepare(`
      INSERT INTO coach_messages (id, session_id, kind, speaker, body, audio_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, sessionId, kind, speaker, body, audioPath, createdAt);
    return id;
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

  function modelProblem() {
    const provider = setting("llmProvider") || "openai";
    const model = setting("llmModel");
    const key = setting("llmApiKey");
    const base = setting("llmBaseUrl") || PROVIDER_BASES[provider] || "";
    if (!model) return "Choose a chat model on API & Docker. Listening and the transcript still stay here.";
    const local = provider === "ollama" || /localhost|127\.0\.0\.1/.test(base);
    if (!local && !key) return "Add an API key for the chat model on API & Docker. The transcript is saved either way.";
    return "";
  }

  async function chatComplete(messages) {
    const problem = modelProblem();
    if (problem) throw new Error(problem);
    const provider = setting("llmProvider") || "openai";
    const model = setting("llmModel");
    const key = setting("llmApiKey");
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
          max_tokens: 700,
          system,
          messages: anthropicMessages(messages),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || "The Anthropic model rejected the request.");
      return payload.content?.map((part) => part.text || "").join("\n").trim();
    }
    const base = (setting("llmBaseUrl") || PROVIDER_BASES[provider] || "").replace(/\/$/, "");
    if (!base) throw new Error("Add a base URL for this chat model.");
    const response = await fetchWithTimeout(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ model, temperature: 0.4, messages }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error?.message || "The chat model rejected the request.");
    return String(payload.choices?.[0]?.message?.content || "").trim();
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

  function rememberPersona(text) {
    const previous = setting("coachInstructions");
    const next = previous ? `${previous}\n${text}` : text;
    putSetting("coachInstructions", next.length > 2000 ? text : next);
  }

  async function coachTurn(sessionId, { mode = "turn", outcome = "", notes = "" } = {}) {
    const row = sessionRow(sessionId);
    if (!row) return null;
    const current = mapSession(row);
    const spoken = current.messages.filter((message) => message.kind === "prospect" || message.kind === "note").map((message) => message.body).join(" ");
    const lessons = await retrieve(`${spoken}\n${current.leadCompany}\n${outcome}`);
    const lessonText = lessons.length
      ? lessons.map((hit) => `(${hit.kind}) ${hit.body}`).join("\n---\n")
      : "No saved playbook sections, reviews, or corrections matched this call.";
    const profile = persona();
    const task = mode === "review"
      ? "Write the post-call review. Cover what went well and what to change next time. No scores or percentages. Use short paragraphs."
      : mode === "note"
        ? "Answer the latest note written to you. If it changes how you should coach, confirm that in one sentence. Add what to say next only when the transcript has a prospect turn."
        : "The prospect just finished a turn. In 2 to 4 sentences, say what Me should say next and why.";
    const system = [
      `You are ${profile.name}, a live sales coach sitting beside the caller.`,
      `Directness: ${profile.directness}.`,
      profile.product ? `What they sell: ${profile.product}.` : "",
      `Standing instructions:\n${profile.instructions}`,
      "The caller is labeled Me. Everyone else uses the speaker name in the transcript.",
      "Do not invent scores, win rates, or facts that are not in the context.",
      "Do not speak as if you are on the phone. Write to Me.",
      task,
      `Lead and script:\n${leadContext(row.lead_id)}`,
      `Retrieved playbooks, reviews, and corrections:\n${lessonText}`,
    ].filter(Boolean).join("\n\n");
    const conversation = [{ role: "system", content: system }];
    const lines = transcript(current.messages);
    if (mode === "review") {
      conversation.push({
        role: "user",
        content: `The call is over. Outcome: ${outcome || "unspecified"}. Notepad: ${notes || "empty"}.\n\nTranscript:\n${lines || "(no transcript)"}`,
      });
    } else if (lines) {
      conversation.push({ role: "user", content: lines });
    }
    let body;
    let answered = false;
    try {
      body = await chatComplete(conversation);
      answered = true;
      if (!body) body = "The model returned an empty note.";
    } catch (error) {
      body = error.message;
    }
    addMessage(sessionId, { kind: mode === "review" ? "review" : "coach", speaker: profile.name, body });
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

  function deleteLeadCoach(leadId) {
    const sessions = db.prepare("SELECT id FROM coach_sessions WHERE lead_id = ?").all(leadId);
    for (const session of sessions) {
      const messages = db.prepare("SELECT id, audio_path FROM coach_messages WHERE session_id = ?").all(session.id);
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
      db.prepare("DELETE FROM coach_messages WHERE session_id = ?").run(session.id);
    }
    db.prepare("DELETE FROM coach_sessions WHERE lead_id = ?").run(leadId);
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
      SELECT * FROM coach_sessions WHERE lead_id = ? AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1
    `).get(lead.id);
    if (open) {
      res.json(mapSession(open));
      return;
    }
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO coach_sessions (id, lead_id, created_at) VALUES (?, ?, ?)").run(id, lead.id, nowIso());
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
      SELECT * FROM coach_sessions WHERE lead_id = ? AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1
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
    if (isProspect && text && !row.paused) {
      await coachTurn(row.id);
    }
    res.json(mapSession(sessionRow(row.id)));
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.status(500).json({ error: "The coach could not save that line." });
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
    if (!row.paused) await coachTurn(row.id, { mode: "note" });
    const session = mapSession(sessionRow(row.id));
    res.json({ ...session, personaUpdated });
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.status(500).json({ error: "The coach could not answer that note." });
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
