const OUTCOMES = [
  { id: "positive", key: "1", label: "Interested", hint: "Qualified", tone: "border-emerald-700/70 hover:bg-emerald-950/50" },
  { id: "not_interested", key: "2", label: "Not Interested", hint: "Leave the queue", tone: "border-slate-600 hover:bg-slate-900" },
  { id: "voicemail", key: "3", label: "Voicemail", hint: "Follow-up draft", tone: "border-sky-800 hover:bg-sky-950/40" },
  { id: "no_answer", key: "4", label: "No Answer / Busy", hint: "Retry on cadence", tone: "border-amber-800/80 hover:bg-amber-950/30" },
  { id: "dnc", key: "5", label: "Do Not Call", hint: "Remove from queue", tone: "border-rose-800 hover:bg-rose-950/40" },
];

const STATUS_LABELS = {
  new: "New",
  no_answer: "No Answer",
  voicemail: "Left Voicemail",
  positive: "Interested",
  not_interested: "Not Interested",
  dnc: "DNC",
};

const NAV = [
  ["dial", "Power Dialer"],
  ["leads", "Leads"],
  ["inbox", "Inbox"],
  ["campaigns", "Campaigns"],
  ["scripts", "Scripts"],
  ["coach", "Coach"],
  ["analytics", "Analytics"],
  ["config", "API & Docker"],
];

const MAIL_FOLDERS = [
  ["all", "All inboxes"],
  ["needs_reply", "Needs reply"],
  ["triggers", "Automated triggers"],
  ["no_answer", "No-answer follow-ups"],
  ["voicemail", "Voicemail follow-ups"],
  ["idle", "3-day idle"],
  ["sent", "Sent"],
  ["drafts", "Drafts"],
  ["paused", "Paused"],
];

const TAGS = ["Budget", "Follow-up", "Gatekeeper", "Send deck"];

const state = {
  view: "dial",
  stats: null,
  health: null,
  settings: { gvLine: "", clipboardFallback: true },
  campaigns: [],
  scripts: [],
  leads: [],
  logs: [],
  queue: { lead: null, upcoming: null, ready: 0, waiting: 0, reasons: {} },
  campaignFilter: "",
  statusFilter: "",
  search: "",
  selected: new Set(),
  detail: null,
  draftNotes: "",
  dialTab: "chat",
  leadsTab: "profile",
  leadModal: false,
  recordNotes: [],
  profileDirty: false,
  noteEdit: null,
  noteTags: [],
  noteDraft: "",
  profileDraft: null,
  draftId: null,
  saveState: "idle",
  dialStartedAt: null,
  timers: {},
  webhooks: [],
  paused: false,
  busy: false,
  objectionLabel: null,
  session: { started: Date.now(), dials: 0, connected: 0, talk: 0 },
  builderId: null,
  scriptId: null,
  apiResult: "",
  apiPath: "/api/health",
  inboxFolder: "all",
  inboxSearch: "",
  inboxThreads: [],
  inboxSuggestions: [],
  inboxSummary: null,
  inboxSnippets: [],
  inboxId: null,
  inboxDetail: null,
  composing: false,
  coachSession: null,
  coachPin: false,
  coachStatus: "",
  coachActions: [],
  coachEdit: null,
  coachInfo: null,
  coachLiveId: null,
  playbooks: [],
  playbookId: null,
  wrongFor: null,
};

let notesTimer = null;
let toastTimer = null;
let searchTimer = null;
let captureHandle = null;
let clipChain = Promise.resolve();

function esc(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function voiceUrl(phone) {
  return `https://voice.google.com/u/0/calls?a=nc,%2B${phone}`;
}

function formatPhone(digits) {
  if (!digits) return "";
  if (String(digits).length === 11 && String(digits).startsWith("1")) {
    const n = String(digits);
    return `+1 (${n.slice(1, 4)}) ${n.slice(4, 7)}-${n.slice(7)}`;
  }
  return digits ? `+${digits}` : "";
}

function e164(digits) {
  return digits ? `+${digits}` : "";
}

function formatWhen(iso) {
  if (!iso) return "Never";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

const WEBHOOK_EVENTS = [
  ["lead.created", "Lead created"],
  ["lead.updated", "Lead updated"],
  ["lead.archived", "Lead archived"],
  ["lead.restored", "Lead restored"],
  ["lead.dialed", "Dial recorded"],
  ["lead.disposition", "Disposition"],
  ["lead.attempts_reset", "Attempts reset"],
  ["campaign.enrolled", "Campaign enroll"],
  ["email.drafted", "Email draft"],
  ["email.sent", "Email sent"],
  ["email.local", "Local outbox"],
];

function timerRecord(id) {
  if (!state.timers[id]) state.timers[id] = { running: false, startedAt: null, elapsed: 0 };
  return state.timers[id];
}

function timerSeconds(id) {
  const timer = timerRecord(id);
  const live = timer.running && timer.startedAt ? (Date.now() - timer.startedAt) / 1000 : 0;
  return Math.max(0, Math.round(timer.elapsed + live));
}

function startTimer(id) {
  const timer = timerRecord(id);
  if (timer.running) return;
  timer.running = true;
  timer.startedAt = Date.now();
}

function stopTimer(id) {
  const timer = timerRecord(id);
  if (!timer.running || !timer.startedAt) return;
  timer.elapsed += (Date.now() - timer.startedAt) / 1000;
  timer.running = false;
  timer.startedAt = null;
}

function consumeTimer(id) {
  stopTimer(id);
  const seconds = timerSeconds(id);
  delete state.timers[id];
  return {
    durationSeconds: seconds,
    startedAt: seconds ? new Date(Date.now() - seconds * 1000).toISOString() : null,
  };
}

function timerControls(id) {
  return `
    <div class="mt-3 flex flex-wrap items-center gap-2">
      <span class="text-[11px] uppercase tracking-wide text-slate-500">Call timer</span>
      <span data-timer="${esc(id)}" class="font-mono text-lg text-white">${formatDuration(timerSeconds(id))}</span>
      <button type="button" data-action="timer-start" data-id="${esc(id)}" class="rounded-lg border border-line px-2 py-1 text-xs text-mint">Start</button>
      <button type="button" data-action="timer-stop" data-id="${esc(id)}" class="rounded-lg border border-line px-2 py-1 text-xs">Stop</button>
      <span class="text-[11px] text-slate-500">Dial starts it. Stop it when the call ends.</span>
    </div>
  `;
}

function formatDuration(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(total / 60);
  const remain = total % 60;
  return `${minutes}:${String(remain).padStart(2, "0")}`;
}

function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function percent(rate) {
  return `${Math.round((rate || 0) * 100)}%`;
}

function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0] || "";
}

function fillTokens(text, lead) {
  if (!lead) return text || "";
  return String(text || "")
    .replaceAll("{{first_name}}", firstName(lead.name))
    .replaceAll("{{name}}", lead.name || "")
    .replaceAll("{{company}}", lead.company || "your team");
}

function localTime(timezone) {
  const options = { hour: "numeric", minute: "2-digit" };
  if (timezone) options.timeZone = timezone;
  try {
    return new Intl.DateTimeFormat(undefined, options).format(new Date());
  } catch {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date());
  }
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 2200);
}

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data.error || "Request failed.");
  return data;
}

async function consumeCoachStream(path, body, handlers = {}) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ ...body, stream: true }),
  });
  const type = res.headers.get("content-type") || "";
  if (!type.includes("text/event-stream")) {
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
    if (!res.ok) throw new Error(data.error || "Request failed.");
    const payload = { type: "done", session: data, personaUpdated: data.personaUpdated, notepadUpdated: data.notepadUpdated };
    handlers.onDone?.(payload);
    return payload;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let donePayload = null;
  const take = (chunk) => {
    const line = chunk.split("\n").filter((item) => item.startsWith("data:")).map((item) => item.slice(5).trim()).join("");
    if (!line) return;
    const event = JSON.parse(line);
    if (event.type === "start") handlers.onStart?.();
    else if (event.type === "delta") handlers.onDelta?.(event.text || "");
    else if (event.type === "reset") handlers.onReset?.();
    else if (event.type === "status") handlers.onStatus?.(event.body || "");
    else if (event.type === "error") throw new Error(event.error || "The coach could not finish that reply.");
    else if (event.type === "done") {
      donePayload = event;
      handlers.onDone?.(event);
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";
    for (const chunk of chunks) take(chunk);
  }
  if (buffer.trim()) take(buffer);
  if (!donePayload) throw new Error("The coach reply stopped before it finished.");
  return donePayload;
}

function campaignById(id) {
  return state.campaigns.find((campaign) => campaign.id === id) || null;
}

async function refreshCore() {
  const [stats, campaigns, scripts, settings, coachActions] = await Promise.all([
    api("/api/stats"),
    api("/api/campaigns"),
    api("/api/scripts"),
    api("/api/settings"),
    api("/api/coach/actions").catch(() => []),
  ]);
  state.stats = stats;
  state.campaigns = campaigns;
  state.scripts = scripts;
  state.settings = settings;
  state.coachActions = coachActions;
}

async function loadQueue() {
  const query = state.campaignFilter ? `?campaignId=${encodeURIComponent(state.campaignFilter)}` : "";
  state.queue = await api(`/api/queue/next${query}`);
  const lead = state.queue.lead;
  if (!lead || lead.id !== state.draftId) {
    state.draftId = lead?.id ?? null;
    state.draftNotes = lead?.notes ?? "";
    state.saveState = "idle";
    state.objectionLabel = null;
    state.dialStartedAt = null;
  }
  await syncCoachToQueue();
  if (lead && state.view === "dial") await loadRecordNotes(lead.id);
}

async function loadLeads() {
  const params = new URLSearchParams();
  if (state.search.trim()) params.set("search", state.search.trim());
  if (state.statusFilter === "archived") params.set("archived", "1");
  else if (state.statusFilter) params.set("status", state.statusFilter);
  if (state.campaignFilter) params.set("campaignId", state.campaignFilter);
  const query = params.toString();
  state.leads = await api(`/api/leads${query ? `?${query}` : ""}`);
}

function shell(body) {
  const ready = state.stats?.leads.inQueue ?? state.queue.ready ?? 0;
  const line = state.settings.gvLine ? `GV ${state.settings.gvLine}` : "Google Voice";
  return `
    <header class="sticky top-0 z-20 border-b border-line bg-ink/95 backdrop-blur">
      <div class="mx-auto flex max-w-[1440px] items-center gap-3 px-4 py-2.5">
        <div class="shrink-0 pr-1">
          <div class="text-sm font-semibold tracking-wide text-white">MyDial</div>
          <div class="font-mono text-[10px] text-emerald-300/80">SQLite · local</div>
        </div>
        <nav class="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          ${NAV.map(([id, label]) => `
            <button type="button" data-action="nav" data-view="${id}" class="shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-sm ${state.view === id ? "nav-on" : "text-slate-300 hover:bg-panel"}">
              ${label}
              ${id === "dial" ? `<span class="ml-1 rounded bg-emerald-950 px-1.5 py-0.5 font-mono text-[10px] text-mint">${ready} left</span>` : ""}
              ${id === "leads" ? `<span class="ml-1 font-mono text-[10px] text-slate-500">${state.stats?.leads.total ?? 0}</span>` : ""}
              ${id === "inbox" ? `<span class="ml-1 rounded bg-amber-950 px-1.5 py-0.5 font-mono text-[10px] text-amber-200">${state.stats?.inbox?.unread ?? 0}</span>` : ""}
            </button>
          `).join("")}
        </nav>
        <div class="hidden shrink-0 rounded-full border border-emerald-900/70 bg-emerald-950/40 px-3 py-1 text-xs text-emerald-200 sm:block">${esc(line)}</div>
        <button type="button" data-action="open-lead" class="shrink-0 rounded-lg bg-mint px-3 py-2 text-sm font-semibold text-ink">+ Quick Add</button>
      </div>
    </header>
    <main class="mx-auto max-w-[1440px] px-4 py-5">${body}</main>
  `;
}

let flowRoot = null;
let flowToken = 0;

function render() {
  flowToken += 1;
  if (flowRoot) {
    flowRoot.unmount();
    flowRoot = null;
  }
  const pages = { dial: renderDial, leads: renderLeads, inbox: renderInbox, campaigns: renderCampaigns, scripts: renderScripts, coach: renderCoachPage, analytics: renderAnalytics, config: renderConfig };
  document.getElementById("app").innerHTML = shell((pages[state.view] || renderDial)());
  paintTimer();
  const coachLog = document.getElementById("coach-log");
  if (coachLog) coachLog.scrollTop = coachLog.scrollHeight;
  if (state.view === "campaigns") {
    const token = flowToken;
    queueMicrotask(() => { void mountCampaignFlow(token); });
  }
}

async function mountCampaignFlow(token) {
  const campaign = campaignById(state.builderId) || state.campaigns[0];
  const el = document.getElementById("flow-canvas");
  if (!campaign || !el || token !== flowToken) return;
  try {
    const mod = await import("/flow.js");
    const node = document.getElementById("flow-canvas");
    if (!node || token !== flowToken) return;
    flowRoot = mod.mount(node, {
      flow: campaign.flow || mod.defaultFlow(),
      cadence: campaign.cadence,
      saved: Boolean(campaign.flow),
      onSave: async ({ flow, cadence }) => {
        const saved = await api(`/api/campaigns/${campaign.id}`, {
          method: "PATCH",
          body: JSON.stringify({ flow, cadence }),
        });
        const index = state.campaigns.findIndex((item) => item.id === saved.id);
        if (index >= 0) state.campaigns[index] = saved;
        showToast("Flow saved");
      },
    });
  } catch (error) {
    const node = document.getElementById("flow-canvas");
    if (node) node.innerHTML = `<p class="p-6 text-sm text-rose-200">The flow builder could not load. Check the network connection and reload.</p>`;
  }
}

async function showView(view) {
  state.view = view;
  if (view === "dial") await loadQueue();
  if (view === "leads") await loadLeads();
  if (view === "analytics") {
    state.stats = await api("/api/stats");
    state.logs = await api("/api/call-logs");
  }
  if (view === "inbox") {
    state.leads = await api("/api/leads");
    await loadInbox();
  }
  if (view === "config") {
    state.health = await api("/api/health");
    state.webhooks = await api("/api/webhooks");
  }
  if (view === "coach") {
    state.playbooks = await api("/api/playbooks");
    if (!state.playbookId && state.playbooks[0]) state.playbookId = state.playbooks[0].id;
  }
  if (view === "campaigns" && !state.builderId && state.campaigns[0]) state.builderId = state.campaigns[0].id;
  if (view === "scripts" && !state.scriptId && state.scripts[0]) state.scriptId = state.scripts[0].id;
  render();
}

function renderDial() {
  const lead = state.queue.lead;
  const campaign = lead ? campaignById(lead.campaignId) : campaignById(state.campaignFilter);
  const ready = state.queue.ready || 0;
  const sessionTotal = state.session.dials + ready;
  const progress = sessionTotal ? Math.round((state.session.dials / sessionTotal) * 100) : 0;
  const reasons = Object.entries(state.queue.reasons || {}).map(([reason, count]) => `${count} ${reason.toLowerCase()}`).join(" · ");
  return `
    <section class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div>
        <select id="dial-campaign" class="field w-auto max-w-xs text-sm font-semibold">
          <option value="">All queued leads</option>
          ${state.campaigns.map((item) => `<option value="${esc(item.id)}" ${item.id === state.campaignFilter ? "selected" : ""}>${esc(item.name)}</option>`).join("")}
        </select>
        <p class="mt-1 text-xs text-slate-400">${progress}% through this session · ${state.session.dials} dialed · ${ready} remaining${reasons ? ` · ${esc(reasons)}` : ""}</p>
      </div>
      <div class="flex items-center gap-2 text-xs">
        <span class="font-mono text-mint" id="session-clock">${formatClock(Date.now() - state.session.started)}</span>
        <button type="button" data-action="skip" class="rounded-lg border border-line px-3 py-2 hover:bg-panel">Skip next</button>
        <button type="button" data-action="pause" class="rounded-lg border border-line px-3 py-2 hover:bg-panel">${state.paused ? "Resume queue" : "Pause queue"}</button>
      </div>
    </section>
    <div class="mb-4 h-1.5 overflow-hidden rounded-full bg-panel"><div class="h-full bg-mint" style="width:${progress}%"></div></div>
    ${lead ? renderFocus(lead, campaign) : `
      <section class="grid items-start gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(280px,2fr)]">
        ${state.coachSession ? coachPanel(null) : ""}
        <section class="rounded-2xl border border-dashed border-line px-8 py-16 text-center">
          <h2 class="text-2xl font-semibold text-white">Queue is clear</h2>
          <p class="mt-2 text-sm text-slate-400">${ready === 0 && state.queue.waiting ? "Leads are waiting on the cadence window or a retry backoff." : "Add a lead or send a filtered list into the queue."}</p>
        </section>
      </section>
    `}
    <footer class="mt-4 flex flex-wrap gap-4 border-t border-line pt-3 text-xs text-slate-400">
      <span>Calls this session: ${state.session.dials}</span>
      <span>Connected: ${state.session.connected}</span>
      <span>Talk time: ${formatDuration(state.session.talk)}</span>
      <span>Next: ${esc(state.queue.upcoming?.name || "—")}</span>
    </footer>
  `;
}

function coachPrivacy(settings = state.settings) {
  const leaves = [];
  if (settings.sttMode === "remote") leaves.push("call audio is sent to the transcription URL");
  const localChat = settings.llmProvider === "ollama" || /localhost|127\.0\.0\.1/.test(settings.llmBaseUrl || "");
  const chatModel = settings.llmLiveModel || settings.llmReviewModel || settings.llmModel;
  if (chatModel && !localChat) leaves.push("the transcript and your notes are sent to the chat model");
  const localEmbed = !settings.embedProvider || settings.embedProvider === "none" || settings.embedProvider === "ollama" || /localhost|127\.0\.0\.1/.test(settings.embedBaseUrl || "");
  if (!localEmbed) leaves.push("playbooks, reviews, and corrections are sent to the embedding model");
  if (!leaves.length) return "Speech recognition stays in this browser. A local chat model keeps the transcript on this machine.";
  return `Leaves this machine: ${leaves.join("; ")}.`;
}

function coachSvg(name) {
  const paths = {
    edit: '<path d="M4 16.5V19h2.5L17 8.5 14.5 6 4 16.5z"/><path d="M13 7.5l2.5 2.5"/>',
    copy: '<rect x="8" y="8" width="10" height="10" rx="1.5"/><path d="M6 14H5.5A1.5 1.5 0 0 1 4 12.5v-8A1.5 1.5 0 0 1 5.5 3h8A1.5 1.5 0 0 1 15 4.5V6"/>',
    info: '<circle cx="11" cy="11" r="7"/><path d="M11 10v5"/><path d="M11 7.5h.01"/>',
    branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="17" r="2"/><circle cx="16" cy="11" r="2"/><path d="M6 7v8"/><path d="M8 11h6"/>',
    up: '<path d="M7 11v7h3l1-4h4.2a1.5 1.5 0 0 0 1.5-1.8l-.8-4A1.5 1.5 0 0 0 14.4 7H11l.4-2.2A1.6 1.6 0 0 0 9.8 3L7 8"/>',
    down: '<path d="M7 11V4h3l1 4h4.2a1.5 1.5 0 0 1 1.5 1.8l-.8 4a1.5 1.5 0 0 1-1.5 1.2H11l.4 2.2A1.6 1.6 0 0 1 9.8 19L7 14"/>',
    play: '<path d="M8 5.5v11l9-5.5-9-5.5z"/>',
    regen: '<path d="M16.5 8A6 6 0 1 0 17 13"/><path d="M16.5 4.5V8H13"/>',
  };
  return `<svg viewBox="0 0 22 22" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths[name] || ""}</svg>`;
}

function coachToolButton(name, label, id, on = false) {
  return `<button type="button" title="${esc(label)}" aria-label="${esc(label)}" data-action="coach-${name}" data-id="${esc(id)}" class="rounded p-1 ${on ? "text-mint" : "text-slate-400 hover:bg-white/5 hover:text-slate-100"}">${coachSvg(name === "edit" ? "edit" : name === "copy" ? "copy" : name === "info" ? "info" : name === "branch" ? "branch" : name === "up" ? "up" : name === "down" ? "down" : name === "continue" ? "play" : "regen")}</button>`;
}

function messageActions(message) {
  const custom = (state.coachActions || []).filter((action) => action.enabled && action.placement === "message" && (action.kinds || []).includes(message.kind));
  const buttons = [coachToolButton("copy", "Copy", message.id)];
  buttons.push(coachToolButton("edit", "Edit", message.id));
  if (message.kind === "coach") {
    buttons.push(
      coachToolButton("info", "Details", message.id, state.coachInfo === message.id),
      coachToolButton("branch", "Branch", message.id),
      coachToolButton("up", "Good reply", message.id, message.rating === "up"),
      coachToolButton("down", "Wrong", message.id, message.rating === "down" || state.wrongFor === message.id),
      coachToolButton("continue", "Continue", message.id),
      coachToolButton("regen", "Regenerate", message.id),
    );
  } else if (message.kind === "review") {
    buttons.push(
      coachToolButton("info", "Details", message.id, state.coachInfo === message.id),
      coachToolButton("up", "Good reply", message.id, message.rating === "up"),
      coachToolButton("down", "Wrong", message.id, message.rating === "down" || state.wrongFor === message.id),
    );
  }
  const extra = custom.map((action) => `
    <button type="button" title="${esc(action.label)}" aria-label="${esc(action.label)}" data-action="coach-run" data-action-id="${esc(action.id)}" data-id="${esc(message.id)}" class="rounded px-1 text-sm text-slate-300 hover:bg-white/5">${esc(action.icon || "•")}</button>
  `);
  const siblings = message.siblingCount > 1 ? `
    <span class="mr-1 flex items-center gap-1 text-[11px] text-slate-400">
      <button type="button" data-action="coach-sibling" data-id="${esc(message.id)}" data-dir="-1" class="px-1 ${message.siblingIndex <= 1 ? "opacity-30" : ""}" aria-label="Previous reply">‹</button>
      ${message.siblingIndex}/${message.siblingCount}
      <button type="button" data-action="coach-sibling" data-id="${esc(message.id)}" data-dir="1" class="px-1 ${message.siblingIndex >= message.siblingCount ? "opacity-30" : ""}" aria-label="Next reply">›</button>
    </span>
  ` : "";
  return `<div class="mt-2 flex items-center gap-0.5 overflow-x-auto">${siblings}${buttons.join("")}${extra.join("")}</div>`;
}

function coachInfoLine(message) {
  const meta = message.meta || {};
  const parts = [];
  if (meta.model) parts.push(meta.model);
  if (meta.ms) parts.push(`${Math.max(1, Math.round(meta.ms / 100) / 10)}s`);
  if (meta.tools?.length) parts.push(`Used ${meta.tools.join(", ")}`);
  return parts.length ? parts.join(" · ") : "No generation details were saved for this reply.";
}

function coachBubble(message) {
  if (message.kind === "status") {
    return `<p class="text-center text-[11px] text-slate-500">${esc(message.body)}</p>`;
  }
  const mine = message.kind === "me" || message.kind === "note";
  const tone = message.kind === "review"
    ? "border-amber-800/80 bg-amber-950/30"
    : message.kind === "coach"
      ? "border-emerald-900 bg-emerald-950/40"
      : message.kind === "note"
        ? "border-line bg-ink/40"
        : "border-line bg-ink/70";
  const align = mine ? "ml-6" : "mr-6";
  const editing = state.coachEdit === message.id;
  return `
    <article class="rounded-xl border px-3 py-2 ${tone} ${align}">
      <div class="flex items-center justify-between gap-2">
        ${message.kind === "me" || message.kind === "prospect"
          ? `<input data-speaker-for="${esc(message.id)}" class="w-28 bg-transparent text-[11px] uppercase tracking-wide text-slate-400 outline-none" value="${esc(message.speaker)}">`
          : `<p class="text-[11px] uppercase tracking-wide text-slate-400">${esc(message.speaker)}${message.kind === "review" ? " · review" : ""}</p>`}
      </div>
      ${editing ? `
        <form data-edit-form="${esc(message.id)}" class="mt-2">
          <textarea name="body" rows="4" class="field">${esc(message.body)}</textarea>
          <div class="mt-2 flex gap-2">
            <button class="rounded-lg bg-mint px-2 py-1 text-xs font-semibold text-ink">Save</button>
            <button type="button" data-action="coach-edit-cancel" class="text-xs text-slate-400">Cancel</button>
          </div>
        </form>
      ` : `<p class="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-100">${esc(message.body)}</p>`}
      ${message.hasAudio ? `<audio class="mt-2 h-8 w-full" controls src="/api/coach/audio/${esc(message.id)}"></audio>` : ""}
      ${(message.corrections || []).map((item) => `<p class="mt-2 text-[11px] text-rose-200">Wrong because: ${esc(item.reason)}</p>`).join("")}
      ${state.coachInfo === message.id ? `<p class="mt-2 text-[11px] leading-5 text-slate-400">${esc(coachInfoLine(message))}</p>` : ""}
      ${state.wrongFor === message.id ? `
        <form data-wrong-form="${esc(message.id)}" class="mt-2 flex gap-2">
          <input name="reason" class="field" placeholder="What should it have done?">
          <button class="rounded-lg bg-mint px-2 text-xs font-semibold text-ink">Save</button>
        </form>
      ` : ""}
      ${messageActions(message)}
    </article>
  `;
}

function coachStrip() {
  const actions = (state.coachActions || []).filter((action) => action.enabled && action.placement === "strip");
  if (!actions.length) return "";
  return `
    <div class="flex gap-1 overflow-x-auto border-t border-line px-3 py-2">
      ${actions.map((action) => `
        <button type="button" title="${esc(action.label)}" aria-label="${esc(action.label)}" data-action="coach-strip" data-action-id="${esc(action.id)}" class="shrink-0 rounded-full border border-line px-2 py-1 text-[11px] text-slate-300 hover:border-mint hover:text-mint">${esc(action.icon)} ${esc(action.label)}</button>
      `).join("")}
    </div>
  `;
}

function coachPanel(lead) {
  const session = state.coachSession;
  const otherLead = session && lead && session.leadId !== lead.id;
  const liveElsewhere = captureHandle && state.coachLiveId && session && state.coachLiveId !== session.id;
  return `
    <aside class="flex max-h-[calc(100vh-6.5rem)] flex-col rounded-2xl border border-line bg-panel xl:sticky xl:top-16">
      <div class="border-b border-line px-4 py-3">
        <div class="flex items-center justify-between gap-2">
          <h3 class="text-sm font-semibold text-white">${esc(session?.leadName ? `Coach · ${session.leadName}` : "Coach")}</h3>
          <div class="flex gap-2">
            ${session ? `<button type="button" data-action="coach-reset" class="text-[11px] text-slate-300">Reset chat</button>` : ""}
            ${session ? `<button type="button" data-action="coach-pause" class="text-[11px] text-mint">${session.paused ? "Resume coach" : "Pause coach"}</button>` : ""}
            ${captureHandle ? `<button type="button" data-action="coach-stop" class="text-[11px] text-slate-400">Stop listening</button>` : ""}
            ${session ? `<button type="button" data-action="coach-hide" class="text-[11px] text-slate-500">Hide</button>` : ""}
          </div>
        </div>
        ${session?.branches?.length > 1 ? `
          <select id="coach-branch" class="field mt-2 text-xs">
            ${session.branches.map((branch) => `<option value="${esc(branch.id)}" ${branch.id === session.id ? "selected" : ""}>${esc(branch.label)}</option>`).join("")}
          </select>
        ` : ""}
        <p id="coach-status" class="mt-1 text-[11px] text-slate-400">${esc(state.coachStatus || coachReadyLine(lead, session))}</p>
        ${liveElsewhere ? `<p class="mt-1 text-[11px] text-amber-200">The live call is still recording on the original thread.</p>` : ""}
        ${otherLead ? `<p class="mt-1 text-[11px] text-amber-200">Showing ${esc(session.leadName)} while ${esc(lead.name)} is up next.</p>` : ""}
        <p class="mt-1 text-[11px] text-slate-500">${esc(coachPrivacy())}</p>
      </div>
      <div id="coach-log" class="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        ${session?.messages?.length ? session.messages.map(coachBubble).join("") : `<p class="text-sm text-slate-500">${lead ? "Ask how to open, what to watch for, or how to handle an objection. Dial when you want the coach to listen to the live call." : "The thread fills in as you talk. Typed messages here are to the coach."}</p>`}
        ${session?.reviewStatus === "pending" ? `<p class="text-center text-[11px] text-amber-200">Writing the review…</p>` : ""}
      </div>
      ${coachStrip()}
      <form id="coach-form" class="flex gap-2 border-t border-line p-3">
        <input id="coach-input" class="field" placeholder="${lead || session ? "Prep this call, or say “be more direct”" : "Queue a lead to talk to the coach"}" ${lead || session ? "" : "disabled"}>
        <button class="rounded-lg bg-mint px-3 text-sm font-semibold text-ink" ${lead || session ? "" : "disabled"}>Send</button>
      </form>
    </aside>
  `;
}

function coachReadyLine(lead, session) {
  if (session && captureHandle) return "Listening to the call.";
  if (session) return "Ready for prep. Dial when you want the coach to listen.";
  if (lead) return "You can prep before you dial.";
  return "Queue a lead to talk to the coach.";
}

let parkedCoach = null;

async function ensureCoachSession(lead) {
  const current = state.coachSession;
  if (current && !current.endedAt && lead && current.leadId === lead.id) return current;
  if (current && !current.endedAt && state.coachPin && (!lead || current.leadId === lead.id)) return current;
  if (!lead) throw new Error("Queue a lead before talking to the coach.");
  if (current && current.leadId !== lead.id) {
    parkedCoach = { session: current, pin: state.coachPin, liveId: state.coachLiveId };
    state.coachPin = false;
  }
  const session = await api("/api/coach/sessions", {
    method: "POST",
    body: JSON.stringify({ leadId: lead.id }),
  });
  state.coachSession = session;
  if (!captureHandle) state.coachLiveId = session.id;
  return session;
}

function restoreParkedCoach() {
  if (!parkedCoach) return;
  state.coachSession = parkedCoach.session;
  state.coachPin = parkedCoach.pin;
  state.coachLiveId = captureHandle ? state.coachLiveId : parkedCoach.liveId;
  parkedCoach = null;
}

function coachActionById(id) {
  return (state.coachActions || []).find((action) => action.id === id);
}

async function applyCoachResult(result) {
  if (result?.session) state.coachSession = result.session;
  if (result?.personaUpdated) state.settings = await api("/api/settings");
  if (result?.notepadUpdated && state.coachSession?.leadId) {
    await loadRecordNotes(state.coachSession.leadId);
    const savedLead = await api(`/api/leads/${state.coachSession.leadId}`);
    if (state.queue?.lead?.id === savedLead.id) state.queue.lead = savedLead;
    if (state.detail?.id === savedLead.id) state.detail = savedLead;
    showToast("Note added");
    if (recordTab(state.view === "leads" ? "leads" : "dial") === "notes") render();
  }
}

async function steerCoach(action) {
  const lead = recordLead();
  const session = await ensureCoachSession(lead);
  state.coachSession = await api(`/api/coach/sessions/${session.id}/steer`, {
    method: "POST",
    body: JSON.stringify({ text: action.payload?.text || action.label, label: action.label }),
  });
  state.coachStatus = `Noted: ${action.label}.`;
  paintCoach();
}

async function runCoachAction(action, messageId) {
  if (!action || state.coachBusy) return;
  if (action.effect === "disposition") {
    await onDisposition(action.payload?.outcome, recordLead()?.id);
    return;
  }
  if (action.effect === "steer") {
    await steerCoach(action);
    return;
  }
  const lead = recordLead();
  const session = await ensureCoachSession(lead);
  if (action.effect === "prompt") {
    state.coachBusy = true;
    state.coachStreaming = true;
    coachLiveText = "";
    state.coachStatus = "Writing…";
    try {
      const streamed = await consumeCoachStream(`/api/coach/actions/${action.id}/run`, { sessionId: session.id, messageId }, coachStreamHandlers());
      await applyCoachResult(streamed.session ? streamed : { session: streamed.session });
      if (streamed.session) state.coachSession = streamed.session;
    } finally {
      state.coachBusy = false;
      state.coachStreaming = false;
      coachLiveText = "";
      paintCoach();
    }
    return;
  }
  const result = await api(`/api/coach/actions/${action.id}/run`, {
    method: "POST",
    body: JSON.stringify({ sessionId: session.id, messageId }),
  });
  if (result.disposition) {
    await onDisposition(result.disposition, recordLead()?.id);
    return;
  }
  await applyCoachResult(result);
  paintCoach();
}

async function streamCoachMessage(path, body) {
  state.coachBusy = true;
  state.coachStreaming = true;
  coachLiveText = "";
  state.coachStatus = "Writing…";
  try {
    const streamed = await consumeCoachStream(path, body, coachStreamHandlers());
    if (streamed.session) state.coachSession = streamed.session;
  } finally {
    state.coachBusy = false;
    state.coachStreaming = false;
    coachLiveText = "";
    state.coachEdit = null;
    paintCoach();
  }
}

let coachLiveText = "";

function coachStreamHandlers() {
  return {
    onStart() {
      state.coachStreaming = true;
      state.coachStatus = "Writing…";
      const status = document.getElementById("coach-status");
      if (status) status.textContent = "Writing…";
      showCoachDraft();
    },
    onDelta(text) {
      coachLiveText += text;
      if (state.coachStatus === "Looking that up…") {
        state.coachStatus = "Writing…";
        const status = document.getElementById("coach-status");
        if (status) status.textContent = "Writing…";
      }
      showCoachDraft();
    },
    onReset() {
      coachLiveText = "";
      showCoachDraft();
    },
    onStatus(body) {
      state.coachStatus = body;
      const status = document.getElementById("coach-status");
      if (status) status.textContent = body;
    },
  };
}

function showCoachDraft() {
  const log = document.getElementById("coach-log");
  if (!log) return;
  log.querySelector(":scope > p.text-sm.text-slate-500")?.remove();
  let live = document.getElementById("coach-live");
  if (!live) {
    live = document.createElement("article");
    live.id = "coach-live";
    live.className = "mr-8 rounded-xl border border-emerald-900 bg-emerald-950/40 px-3 py-2";
    log.appendChild(live);
  }
  const name = state.settings.coachName || "Coach";
  live.innerHTML = `<p class="text-[11px] uppercase tracking-wide text-slate-400">${esc(name)}</p><p class="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-100">${esc(coachLiveText)}<span class="animate-pulse text-mint">▍</span></p>`;
  log.scrollTop = log.scrollHeight;
}

function showOwnCoachNote(text) {
  const log = document.getElementById("coach-log");
  if (!log) return;
  log.querySelector(":scope > p.text-sm.text-slate-500")?.remove();
  const article = document.createElement("article");
  article.className = "ml-8 rounded-xl border border-line bg-ink/40 px-3 py-2";
  article.innerHTML = `<p class="text-[11px] uppercase tracking-wide text-slate-400">Me</p><p class="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-100">${esc(text)}</p>`;
  log.appendChild(article);
  log.scrollTop = log.scrollHeight;
}

function paintCoach() {
  const aside = document.getElementById("coach-log");
  if (!aside || (state.view !== "dial" && !(state.view === "leads" && state.leadModal))) return;
  if (state.coachStreaming && document.getElementById("coach-live")) {
    const status = document.getElementById("coach-status");
    if (status && state.coachStatus) status.textContent = state.coachStatus;
    aside.scrollTop = aside.scrollHeight;
    return;
  }
  const panel = aside.closest("aside");
  if (!panel) return;
  const draft = document.getElementById("coach-input")?.value || "";
  const fresh = document.createElement("template");
  fresh.innerHTML = coachPanel(recordLead());
  panel.replaceWith(fresh.content.firstElementChild);
  const input = document.getElementById("coach-input");
  if (input && draft) input.value = draft;
  const log = document.getElementById("coach-log");
  if (log) log.scrollTop = log.scrollHeight;
}

function renderCoachPage() {
  const book = state.playbooks.find((item) => item.id === state.playbookId) || null;
  return `
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-lg font-semibold text-white">Coach</h1>
        <p class="mt-1 text-xs text-slate-400">Persona and playbooks are retrieved on later calls. Corrections and reviews are remembered the same way.</p>
      </div>
    </div>
    <div class="mt-4 grid gap-4 xl:grid-cols-2">
      <form id="persona-form" class="rounded-2xl border border-line bg-panel p-4">
        <h2 class="text-sm font-semibold text-white">Persona</h2>
        <p class="mt-1 text-xs text-slate-400">You can also change this in the call thread, for example “be more direct”.</p>
        <label class="mt-3 block text-xs text-slate-400">Name<input name="coachName" class="field mt-1" value="${esc(state.settings.coachName || "Coach")}"></label>
        <label class="mt-3 block text-xs text-slate-400">Directness
          <select name="coachDirectness" class="field mt-1">
            ${["warm", "direct", "challenging"].map((level) => `<option value="${level}" ${state.settings.coachDirectness === level ? "selected" : ""}>${level}</option>`).join("")}
          </select>
        </label>
        <label class="mt-3 block text-xs text-slate-400">What you sell<textarea name="coachProduct" rows="3" class="field mt-1">${esc(state.settings.coachProduct || "")}</textarea></label>
        <label class="mt-3 block text-xs text-slate-400">Instructions<textarea name="coachInstructions" rows="5" class="field mt-1">${esc(state.settings.coachInstructions || "")}</textarea></label>
        <button class="mt-3 rounded-lg bg-mint px-3 py-2 text-sm font-semibold text-ink">Save persona</button>
      </form>
      <form id="playbook-form" class="rounded-2xl border border-line bg-panel p-4">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-semibold text-white">Playbooks</h2>
          <button type="button" data-action="new-playbook" class="text-xs text-mint">New</button>
        </div>
        <div class="mt-3 flex flex-wrap gap-2">
          ${state.playbooks.map((item) => `<button type="button" data-action="select-playbook" data-id="${esc(item.id)}" class="rounded-full border px-2 py-1 text-[11px] ${item.id === book?.id ? "border-mint text-mint" : "border-line text-slate-300"}">${esc(item.name)}</button>`).join("") || `<p class="text-xs text-slate-500">No playbooks yet.</p>`}
        </div>
        <label class="mt-3 block text-xs text-slate-400">Name<input name="name" class="field mt-1" value="${esc(book?.name || "")}"></label>
        <label class="mt-3 block text-xs text-slate-400">Text<textarea name="body" rows="10" class="field mt-1">${esc(book?.body || "")}</textarea></label>
        <div class="mt-3 flex gap-2">
          <button class="rounded-lg bg-mint px-3 py-2 text-sm font-semibold text-ink">Save playbook</button>
          ${book ? `<button type="button" data-action="delete-playbook" data-id="${esc(book.id)}" class="rounded-lg border border-rose-900 px-3 py-2 text-sm text-rose-200">Delete</button>` : ""}
        </div>
      </form>
    </div>
    <section class="mt-4 rounded-2xl border border-line bg-panel p-4">
      <h2 class="text-sm font-semibold text-white">Message actions</h2>
      <p class="mt-1 text-xs text-slate-400">Strip actions sit above the composer. Message actions join the icon row. A file in <span class="font-mono">coach-actions</span> can export a default action with an id, label, icon, placement, kinds, and run function.</p>
      <div class="mt-3 flex flex-wrap gap-2">
        ${(state.coachActions || []).map((action) => `
          <span class="inline-flex items-center gap-2 rounded-full border border-line px-2 py-1 text-[11px] text-slate-300">
            ${esc(action.icon)} ${esc(action.label)}
            <span class="text-slate-500">${esc(action.placement)}${action.shortcut ? ` · ${esc(action.shortcut)}` : ""}</span>
            ${action.source === "plugin" ? `<span class="text-slate-500">plugin</span>` : action.builtin ? `<button type="button" data-action="toggle-coach-action" data-id="${esc(action.id)}" data-enabled="${action.enabled ? "0" : "1"}" class="text-mint">${action.enabled ? "Hide" : "Show"}</button>` : `<button type="button" data-action="delete-coach-action" data-id="${esc(action.id)}" class="text-rose-300">Delete</button>`}
          </span>
        `).join("")}
      </div>
      <form id="coach-action-form" class="mt-4 grid gap-3 md:grid-cols-2">
        <label class="text-xs text-slate-400">Name<input name="label" class="field mt-1" required></label>
        <label class="text-xs text-slate-400">Icon<input name="icon" class="field mt-1" value="•" maxlength="8"></label>
        <label class="text-xs text-slate-400">Where it shows
          <select name="placement" class="field mt-1">
            <option value="strip">Above the composer</option>
            <option value="message">On the message row</option>
          </select>
        </label>
        <label class="text-xs text-slate-400">What it does
          <select name="effect" class="field mt-1">
            <option value="steer">Steer the next reply</option>
            <option value="prompt">Run a prompt in the thread</option>
            <option value="notepad">Add to the notepad</option>
            <option value="memory">Save to coach memory</option>
            <option value="disposition">Log a disposition</option>
          </select>
        </label>
        <label class="text-xs text-slate-400 md:col-span-2">Shortcut<input name="shortcut" class="field mt-1" placeholder="6, 0, or NumpadAdd"></label>
        <fieldset class="text-xs text-slate-400 md:col-span-2">
          <legend>Show on these messages</legend>
          <div class="mt-1 flex flex-wrap gap-3">
            ${["coach", "note", "me", "prospect"].map((kind) => `<label><input type="checkbox" name="kinds" value="${kind}"> ${kind}</label>`).join("")}
          </div>
        </fieldset>
        <label class="text-xs text-slate-400">Disposition
          <select name="outcome" class="field mt-1">
            ${OUTCOMES.map((outcome) => `<option value="${outcome.id}">${esc(outcome.label)}</option>`).join("")}
          </select>
        </label>
        <label class="text-xs text-slate-400 md:col-span-2">Instruction or prompt<textarea name="text" rows="3" class="field mt-1" placeholder="Use {{message}} for the line this was clicked on."></textarea></label>
        <button class="w-fit rounded-lg bg-mint px-3 py-2 text-sm font-semibold text-ink">Add action</button>
      </form>
    </section>
  `;
}

async function syncCoachToQueue() {
  if (state.coachPin) return;
  if (state.coachSession?.reviewStatus === "pending") {
    try {
      state.coachSession = await api(`/api/coach/sessions/${state.coachSession.id}`);
    } catch {
      state.coachSession = null;
    }
    return;
  }
  const lead = state.queue.lead;
  if (!lead) return;
  if (state.coachSession && !state.coachSession.endedAt && state.coachSession.leadId === lead.id) return;
  try {
    const open = await api(`/api/coach/leads/${lead.id}/open`);
    if (open.session) state.coachSession = open.session;
  } catch {
    /* the dialer still works without a thread */
  }
}

const RECORD_TABS = [
  ["chat", "Chat"],
  ["profile", "Profile"],
  ["notes", "Notes"],
  ["disposition", "Disposition"],
  ["history", "History"],
];

function recordLead() {
  if (state.view === "leads" && state.leadModal && state.detail) return state.detail;
  return state.queue?.lead || null;
}

function recordTab(scope) {
  return scope === "leads" ? state.leadsTab : state.dialTab;
}

function askConfirm(message, actions) {
  const root = document.getElementById("confirm");
  const text = document.getElementById("confirm-text");
  const box = document.getElementById("confirm-actions");
  text.textContent = message;
  box.innerHTML = actions.map((action) => `<button type="button" data-confirm="${esc(action.id)}" class="rounded-lg px-3 py-2 text-sm ${action.id === "save" ? "bg-mint font-semibold text-ink" : "border border-line text-slate-200"}">${esc(action.label)}</button>`).join("");
  root.classList.remove("hidden");
  root.classList.add("flex");
  return new Promise((resolve) => {
    box.onclick = (event) => {
      const button = event.target.closest("[data-confirm]");
      if (!button) return;
      root.classList.add("hidden");
      root.classList.remove("flex");
      box.onclick = null;
      resolve(button.dataset.confirm);
    };
  });
}

async function loadRecordNotes(leadId) {
  if (!leadId) {
    state.recordNotes = [];
    return;
  }
  state.recordNotes = await api(`/api/leads/${leadId}/notes`);
}

function recordTabBar(scope) {
  const current = recordTab(scope);
  return `
    <div class="flex gap-1 overflow-x-auto border-b border-line px-2">
      ${RECORD_TABS.map(([id, label]) => `
        <button type="button" data-action="record-tab" data-scope="${scope}" data-tab="${id}" class="shrink-0 border-b-2 px-3 py-2 text-sm ${current === id ? "border-mint text-white" : "border-transparent text-slate-400"}">${label}</button>
      `).join("")}
    </div>
  `;
}

function scriptColumn(lead) {
  const script = lead.script;
  const sections = (script?.sections?.length ? script.sections : [{ label: "Opening", text: script?.body || "" }]).filter((section) => section.text);
  if (!sections.length && !script?.objections?.length) return "";
  return `
    <article class="max-h-[calc(100vh-18rem)] overflow-y-auto rounded-2xl border border-line bg-ink/40 p-4">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold text-white">Script</h3>
        <span class="text-[11px] text-slate-500">${esc(script?.name || "")}</span>
      </div>
      ${sections.map((section) => `
        <div class="mt-4">
          <p class="text-[10px] uppercase tracking-wide text-emerald-300/80">${esc(section.label || "Section")}</p>
          <p class="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-200">${esc(fillTokens(section.text, lead))}</p>
        </div>
      `).join("")}
      ${script?.objections?.length ? `
        <div class="mt-5 border-t border-line pt-4">
          <p class="text-[10px] uppercase tracking-wide text-slate-500">Objections</p>
          <div class="mt-2 space-y-2">
            ${script.objections.map((item) => `
              <button type="button" data-action="objection" data-label="${esc(item.label)}" class="block w-full rounded-lg border border-line px-3 py-2 text-left text-sm hover:border-mint ${state.objectionLabel === item.label ? "border-mint bg-emerald-950/30" : ""}">
                <span class="text-slate-200">${esc(item.label)}</span>
                ${state.objectionLabel === item.label ? `<span class="mt-1 block text-xs leading-5 text-emerald-100">${esc(fillTokens(item.response, lead))}</span>` : ""}
              </button>
            `).join("")}
          </div>
        </div>
      ` : ""}
    </article>
  `;
}

function profileValues(lead) {
  const draft = state.profileDraft;
  if (state.profileDirty && draft?.id === lead.id) return draft;
  return {
    id: lead.id,
    name: lead.name || "",
    title: lead.title || "",
    company: lead.company || "",
    phone: formatPhone(lead.phone),
    email: lead.email || "",
    timezone: lead.timezone || "",
    campaignId: lead.campaignId || "",
    status: lead.status || "new",
  };
}

function profilePanel(lead) {
  const values = profileValues(lead);
  return `
    <form id="profile-form" data-lead="${esc(lead.id)}" class="grid gap-3 sm:grid-cols-2">
      <label class="text-xs text-slate-400">Name<input name="name" class="field mt-1" value="${esc(values.name)}"></label>
      <label class="text-xs text-slate-400">Title<input name="title" class="field mt-1" value="${esc(values.title)}"></label>
      <label class="text-xs text-slate-400">Company<input name="company" class="field mt-1" value="${esc(values.company)}"></label>
      <label class="text-xs text-slate-400">Phone<input name="phone" class="field mt-1" value="${esc(values.phone)}"></label>
      <label class="text-xs text-slate-400">Email<input name="email" class="field mt-1" value="${esc(values.email)}"></label>
      <label class="text-xs text-slate-400">Timezone<input name="timezone" class="field mt-1" value="${esc(values.timezone)}" placeholder="America/New_York"></label>
      <label class="text-xs text-slate-400">Campaign
        <select name="campaignId" class="field mt-1">
          <option value="">No campaign</option>
          ${state.campaigns.map((campaign) => `<option value="${esc(campaign.id)}" ${campaign.id === values.campaignId ? "selected" : ""}>${esc(campaign.name)}</option>`).join("")}
        </select>
      </label>
      <label class="text-xs text-slate-400">Status
        <select name="status" class="field mt-1">
          ${Object.entries(STATUS_LABELS).map(([id, label]) => `<option value="${id}" ${values.status === id ? "selected" : ""}>${esc(label)}</option>`).join("")}
          ${values.status && !STATUS_LABELS[values.status] ? `<option value="${esc(values.status)}" selected>${esc(values.status)}</option>` : ""}
        </select>
      </label>
      <div class="text-sm text-slate-300"><p class="text-[11px] uppercase text-slate-500">Stage</p><p class="mt-1">${esc(lead.stage)}</p></div>
      <div class="text-sm text-slate-300"><p class="text-[11px] uppercase text-slate-500">Score</p><p class="mt-1">${lead.score.value} · ${esc(lead.score.band)}</p></div>
      <div class="text-sm text-slate-300"><p class="text-[11px] uppercase text-slate-500">Attempts</p><p class="mt-1">${lead.attempts}</p></div>
      <div class="text-sm text-slate-300"><p class="text-[11px] uppercase text-slate-500">Queue</p><p class="mt-1">${lead.inQueue ? "In the queue" : "Not in the queue"}</p></div>
      <div class="sm:col-span-2">
        <button class="rounded-lg bg-mint px-3 py-2 text-sm font-semibold text-ink">Save profile</button>
      </div>
    </form>
  `;
}

function notesPanel(lead) {
  const notes = state.recordNotes || [];
  return `
    <form id="note-form" data-lead="${esc(lead.id)}" class="rounded-xl border border-line bg-ink/40 p-3">
      <textarea name="body" rows="3" class="field" placeholder="Write a note about this lead.">${esc(state.noteDraft || "")}</textarea>
      <div class="mt-2 flex flex-wrap gap-2">
        ${TAGS.map((tag) => `
          <button type="button" data-action="note-tag" data-tag="${esc(tag)}" class="rounded-full border px-2 py-1 text-[11px] ${state.noteTags.includes(tag) ? "border-mint text-mint" : "border-line text-slate-300"}">${esc(tag)}</button>
        `).join("")}
      </div>
      <button class="mt-3 rounded-lg bg-mint px-3 py-2 text-sm font-semibold text-ink">Add note</button>
    </form>
    <div class="mt-4 space-y-3">
      ${notes.length ? notes.map((note) => `
        <article class="rounded-xl border border-line bg-ink/40 px-3 py-2">
          <div class="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wide text-slate-500">
            <span>${esc(formatWhen(note.createdAt))}</span>
            <span>${esc(note.author === "me" ? "You" : note.author === "coach" ? "Coach" : "System")}</span>
            ${note.callOutcome ? `<span>${esc(STATUS_LABELS[note.callOutcome] || note.callOutcome)}</span>` : ""}
            ${(note.tags || []).map((tag) => `<span class="rounded-full border border-line px-2 py-0.5 text-slate-300">${esc(tag)}</span>`).join("")}
          </div>
          ${state.noteEdit === note.id ? `
            <form data-note-edit="${esc(note.id)}" class="mt-2">
              <textarea name="body" rows="3" class="field">${esc(note.body)}</textarea>
              <div class="mt-2 flex gap-2">
                <button class="rounded-lg bg-mint px-2 py-1 text-xs font-semibold text-ink">Save</button>
                <button type="button" data-action="note-edit-cancel" class="text-xs text-slate-400">Cancel</button>
              </div>
            </form>
          ` : `<p class="mt-2 whitespace-pre-wrap text-sm text-slate-100">${esc(note.body)}</p>`}
          <div class="mt-2 flex gap-3 text-[11px]">
            <button type="button" data-action="note-edit" data-id="${esc(note.id)}" class="text-slate-400">Edit</button>
            <button type="button" data-action="note-delete" data-id="${esc(note.id)}" class="text-rose-300">Delete</button>
          </div>
        </article>
      `).join("") : `<p class="text-sm text-slate-500">No notes yet.</p>`}
    </div>
  `;
}

function dispositionPanel(lead, campaign) {
  return `
    <p class="text-[11px] text-slate-500">Auto-advance ${campaign?.cadence?.autoAdvance === false ? "off" : "on"} · keys 1–5 still log the outcome on the dialer</p>
    <div class="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
      ${OUTCOMES.map((outcome) => `
        <button type="button" data-action="disposition" data-outcome="${outcome.id}" data-lead="${esc(lead.id)}" class="rounded-xl border bg-ink/40 px-3 py-3 text-left ${outcome.tone}">
          <span class="font-mono text-[10px] text-slate-500">${outcome.key}</span>
          <span class="mt-1 block text-sm font-semibold text-white">${outcome.label}</span>
          <span class="mt-1 block text-[11px] text-slate-400">${outcome.hint}</span>
        </button>
      `).join("")}
    </div>
  `;
}

function historyPanel(lead) {
  const calls = lead.calls || [];
  if (!calls.length) return `<p class="text-sm text-slate-500">No calls logged for this lead.</p>`;
  return `
    <div class="space-y-2">
      ${calls.map((call) => `
        <div class="rounded-lg bg-ink/50 px-3 py-2 text-sm">
          <div class="flex items-start justify-between gap-2">
            <div>
              <span class="text-mint">${esc(STATUS_LABELS[call.outcome] || call.outcome)}</span>
              <span class="text-slate-500"> · ${formatDuration(call.durationSeconds)} · ${esc(formatWhen(call.endedAt))}</span>
            </div>
            <button type="button" data-action="open-coach-call" data-id="${esc(call.id)}" class="text-[11px] text-mint">Thread</button>
          </div>
          ${call.notes ? `<p class="mt-1 text-slate-300">${esc(call.notes)}</p>` : ""}
        </div>
      `).join("")}
    </div>
  `;
}

function recordPanel(lead, campaign, scope) {
  const tab = recordTab(scope);
  if (tab === "chat") {
    const script = scriptColumn(lead);
    return `
      <div class="${script ? "grid items-start gap-4 xl:grid-cols-[minmax(240px,1fr)_minmax(0,2fr)]" : ""}">
        ${script}
        ${coachPanel(lead)}
      </div>
    `;
  }
  if (tab === "profile") return profilePanel(lead);
  if (tab === "notes") return notesPanel(lead);
  if (tab === "disposition") return dispositionPanel(lead, campaign);
  return historyPanel(lead);
}

function recordHeader(lead, { dialAction = "dial" } = {}) {
  const url = voiceUrl(lead.phone);
  return `
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <p class="text-xs uppercase tracking-wide text-slate-500">${esc(lead.stage)} · ${esc(lead.campaignName || "No campaign")}</p>
        <h2 class="mt-1 text-3xl font-semibold text-white">${esc(lead.name)}</h2>
        <p class="mt-1 text-sm text-slate-400">${esc([lead.title, lead.company].filter(Boolean).join(" · ") || "No company")}</p>
        <p class="mt-2 text-xs text-emerald-200/80">${lead.timezone ? `Local time ${esc(localTime(lead.timezone))} · ${esc(lead.timezone)}` : `Your time ${esc(localTime())}`}</p>
      </div>
      <div class="text-right">
        <p class="font-mono text-xl text-mint">${esc(formatPhone(lead.phone))}</p>
        <p id="attempt-count" class="mt-1 text-xs text-slate-500">Attempts ${lead.attempts}${lead.lastCalledAt ? ` · last ${esc(formatWhen(lead.lastCalledAt))}` : ""}</p>
        <p class="mt-1 text-xs text-slate-500">Score ${lead.score.value} ${esc(lead.score.band)}</p>
      </div>
    </div>
    <a id="${dialAction === "dial" ? "dial-link" : ""}" data-action="${dialAction}" data-id="${esc(lead.id)}" href="${esc(url)}" target="_blank" rel="noopener noreferrer" class="mt-5 flex items-center justify-center rounded-xl bg-mint px-4 py-4 text-center text-base font-semibold text-ink ${state.paused && dialAction === "dial" ? "pointer-events-none opacity-40" : "hover:brightness-110"}">
      Open Google Voice &amp; Dial (${esc(formatPhone(lead.phone))})
    </a>
    <p class="mt-2 text-center font-mono text-[11px] text-slate-500">Space or Enter to dial · 1–5 dispositions · 6–0 and numpad steer the coach · N skips</p>
    <div class="mt-3 flex flex-wrap items-center justify-center gap-2">
      ${timerControls(lead.id)}
      <button type="button" data-action="reset-attempts" data-id="${esc(lead.id)}" class="rounded-lg border border-line px-2 py-1 text-xs">Reset attempts</button>
      <button type="button" data-action="archive-lead" data-id="${esc(lead.id)}" data-archived="${lead.archived ? "1" : "0"}" class="rounded-lg border border-line px-2 py-1 text-xs">${lead.archived ? "Restore" : "Archive"}</button>
    </div>
  `;
}

function renderFocus(lead, campaign) {
  return `
    <section class="rounded-2xl border border-line bg-panel">
      <div class="p-5">${recordHeader(lead)}</div>
      ${recordTabBar("dial")}
      <div class="p-4">${recordPanel(lead, campaign, "dial")}</div>
    </section>
  `;
}

function statusCounts() {
  const counts = state.stats?.leads.byStatus || {};
  return [
    ["", "All", state.stats?.leads.total || 0],
    ["new", "New", counts.new || 0],
    ["positive", "Connected", counts.positive || 0],
    ["voicemail", "Voicemail", counts.voicemail || 0],
    ["no_answer", "No answer", counts.no_answer || 0],
    ["dnc", "DNC", counts.dnc || 0],
    ["archived", "Archived", state.stats?.leads.archived || 0],
  ];
}

function leadRecordModal() {
  if (!state.leadModal || !state.detail) return "";
  const lead = state.detail;
  const campaign = campaignById(lead.campaignId);
  return `
    <div class="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/70 px-4 py-8">
      <section class="my-auto w-full max-w-5xl rounded-2xl border border-line bg-panel">
        <div class="flex justify-end px-5 pt-4">
          <button type="button" data-action="close-lead" class="rounded-lg border border-line px-3 py-1 text-sm text-slate-200">Close</button>
        </div>
        <div class="px-5 pb-2">${recordHeader(lead, { dialAction: "dial-row" })}</div>
        ${recordTabBar("leads")}
        <div class="p-4">${recordPanel(lead, campaign, "leads")}</div>
      </section>
    </div>
  `;
}

function renderLeads() {
  return `
    <section class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-lg font-semibold text-white">Leads directory</h1>
        <p class="text-xs text-slate-400">${state.leads.length} showing · ${state.selected.size} selected</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button type="button" data-action="enqueue-selected" class="rounded-lg bg-sky-400 px-3 py-2 text-sm font-semibold text-ink">Enqueue selected (${state.selected.size})</button>
        <button type="button" data-action="enqueue-filtered" class="rounded-lg border border-line px-3 py-2 text-sm hover:bg-panel">Send filtered to queue</button>
        <button type="button" data-action="import" class="rounded-lg border border-line px-3 py-2 text-sm hover:bg-panel">Import CSV</button>
        <button type="button" data-action="export" class="rounded-lg border border-line px-3 py-2 text-sm hover:bg-panel">Export CSV</button>
      </div>
    </section>
    <div class="mb-3 grid gap-2 lg:grid-cols-[minmax(0,1fr)_220px]">
      <input id="search" value="${esc(state.search)}" placeholder="Search name, company, phone, title, or tag" class="field">
      <select id="campaign-filter" class="field">
        <option value="">All campaigns</option>
        ${state.campaigns.map((campaign) => `<option value="${esc(campaign.id)}" ${campaign.id === state.campaignFilter ? "selected" : ""}>${esc(campaign.name)}</option>`).join("")}
      </select>
    </div>
    <div class="mb-3 flex flex-wrap gap-2">
      ${statusCounts().map(([id, label, count]) => `
        <button type="button" data-action="status" data-status="${id}" class="rounded-full border px-3 py-1 text-xs ${state.statusFilter === id ? "chip-on" : "border-line text-slate-300"}">${label} (${count})</button>
      `).join("")}
    </div>
    <div class="overflow-x-auto rounded-2xl border border-line">
      <table class="min-w-full text-left text-sm">
        <thead class="bg-[#0a141e] text-[11px] uppercase tracking-wide text-slate-500">
          <tr>
            <th class="px-3 py-3"><input type="checkbox" data-action="select-page" ${state.leads.length && state.leads.every((lead) => state.selected.has(lead.id)) ? "checked" : ""}></th>
            <th class="px-3 py-3">Prospect</th>
            <th class="px-3 py-3">Company</th>
            <th class="px-3 py-3">Phone</th>
            <th class="px-3 py-3">Stage</th>
            <th class="px-3 py-3">Dials</th>
            <th class="px-3 py-3">Score</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-line">
          ${state.leads.length ? state.leads.map((lead) => `
            <tr role="button" tabindex="0" data-action="select-lead" data-id="${esc(lead.id)}" class="cursor-pointer hover:bg-white/5 ${state.detail?.id === lead.id ? "bg-emerald-950/20" : ""}">
              <td class="px-3 py-3"><input type="checkbox" data-action="check-lead" data-id="${esc(lead.id)}" ${state.selected.has(lead.id) ? "checked" : ""}></td>
              <td class="px-3 py-3"><div class="font-medium text-white">${esc(lead.name)}</div><div class="text-xs text-slate-500">${esc(lead.title || "")}</div></td>
              <td class="px-3 py-3 text-slate-300">${esc(lead.company || "—")}</td>
              <td class="px-3 py-3"><a data-action="dial-row" data-id="${esc(lead.id)}" href="${esc(voiceUrl(lead.phone))}" target="_blank" rel="noopener" class="font-mono text-mint hover:underline">${esc(formatPhone(lead.phone))}</a></td>
              <td class="px-3 py-3 text-xs">${esc(lead.stage)}</td>
              <td class="px-3 py-3">${lead.attempts}</td>
              <td class="px-3 py-3 text-xs">${lead.score.value} <span class="text-slate-500">${esc(lead.score.band)}</span></td>
            </tr>
          `).join("") : `<tr><td colspan="7" class="px-3 py-10 text-center text-slate-500">No leads match.</td></tr>`}
        </tbody>
      </table>
    </div>
    ${leadRecordModal()}
  `;
}

function renderCampaigns() {
  const campaign = campaignById(state.builderId) || state.campaigns[0];
  if (!campaign) {
    return `<section class="rounded-2xl border border-dashed border-line px-8 py-16 text-center"><h1 class="text-2xl font-semibold text-white">No campaigns</h1><p class="mt-2 text-sm text-slate-400">Build a flow of dial reminders, waits, and emails. Connect each dial outcome to the next step.</p><button type="button" data-action="open-campaign" class="mt-4 rounded-lg bg-mint px-4 py-2 text-sm font-semibold text-ink">New campaign</button></section>`;
  }
  return `
    <section class="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-lg font-semibold text-white">${esc(campaign.name)}</h1>
        <p class="text-xs text-slate-400">${campaign.leadCount} enrolled · ${campaign.queuedCount} in the dialer · ${percent(campaign.conversionRate)} connected</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <select id="campaign-status" class="field w-auto text-xs">
          ${["active", "paused", "completed"].map((status) => `<option value="${status}" ${campaign.status === status ? "selected" : ""}>${status}</option>`).join("")}
        </select>
        <select id="campaign-script" class="field w-auto text-xs">
          <option value="">No script</option>
          ${state.scripts.map((script) => `<option value="${esc(script.id)}" ${campaign.scriptId === script.id ? "selected" : ""}>${esc(script.name)}</option>`).join("")}
        </select>
        <button type="button" data-action="open-campaign" class="rounded-lg border border-line px-3 py-2 text-sm">New</button>
        <button type="button" data-action="delete-campaign" data-id="${esc(campaign.id)}" data-name="${esc(campaign.name)}" class="rounded-lg border border-rose-900 px-3 py-2 text-xs text-rose-200">Delete</button>
      </div>
    </section>
    <div class="mb-3 flex flex-wrap gap-2">
      ${state.campaigns.map((item) => `<button type="button" data-action="pick-campaign" data-id="${esc(item.id)}" class="rounded-full border px-3 py-1 text-xs ${item.id === campaign.id ? "chip-on" : "border-line"}">${esc(item.name)}</button>`).join("")}
    </div>
    <div id="flow-canvas" class="overflow-hidden rounded-2xl border border-line" style="height:720px"></div>
  `;
}

function renderScripts() {
  const script = state.scripts.find((item) => item.id === state.scriptId) || state.scripts[0];
  return `
    <section class="mb-4 flex items-center justify-between">
      <div>
        <h1 class="text-lg font-semibold text-white">Scripts & objections</h1>
        <p class="text-xs text-slate-400">Tokens: {{first_name}} and {{company}} fill in on the dialer.</p>
      </div>
      <button type="button" data-action="open-script" class="rounded-lg bg-mint px-3 py-2 text-sm font-semibold text-ink">+ Create script</button>
    </section>
    <div class="grid items-start gap-4 lg:grid-cols-[220px_minmax(0,1fr)_280px]">
      <aside class="rounded-2xl border border-line bg-panel p-3">
        ${state.scripts.length ? state.scripts.map((item) => `
          <button type="button" data-action="pick-script" data-id="${esc(item.id)}" class="mb-1 block w-full rounded-lg px-3 py-2 text-left text-sm ${script?.id === item.id ? "bg-emerald-950/40 text-mint" : "hover:bg-ink"}">${esc(item.name)}</button>
        `).join("") : `<p class="px-2 text-sm text-slate-500">No scripts yet.</p>`}
      </aside>
      ${script ? `
        <article class="rounded-2xl border border-line bg-panel p-4">
          <input id="script-name" class="field text-lg font-semibold" value="${esc(script.name)}">
          <div id="section-list" class="mt-4 space-y-3">
            ${(script.sections.length ? script.sections : [{ label: "Opening", text: script.body }]).map((section, index) => `
              <div class="rounded-xl border border-line p-3" data-section>
                <input data-section-label value="${esc(section.label || "")}" class="field text-xs" placeholder="Section label">
                <textarea data-section-text rows="4" class="field mt-2">${esc(section.text || "")}</textarea>
                <button type="button" data-action="remove-section" data-index="${index}" class="mt-2 text-[11px] text-rose-300">Remove</button>
              </div>
            `).join("")}
          </div>
          <button type="button" data-action="add-section" class="mt-3 text-xs text-mint">+ Section</button>
        </article>
        <aside class="rounded-2xl border border-line bg-panel p-4">
          <div class="flex items-center justify-between">
            <h2 class="text-sm font-semibold">Objections</h2>
            <button type="button" data-action="add-objection" class="text-xs text-mint">Add</button>
          </div>
          <div id="objection-list" class="mt-3 space-y-2">
            ${script.objections.map((item, index) => `
              <div data-objection class="rounded-lg border border-line p-2">
                <input data-objection-label value="${esc(item.label)}" class="field text-xs" placeholder="They say">
                <textarea data-objection-response rows="3" class="field mt-2 text-xs">${esc(item.response)}</textarea>
                <button type="button" data-action="remove-objection" data-index="${index}" class="mt-1 text-[11px] text-rose-300">Remove</button>
              </div>
            `).join("")}
          </div>
          <div class="mt-4 flex gap-2">
            <button type="button" data-action="save-script" class="rounded-lg bg-mint px-3 py-2 text-sm font-semibold text-ink">Save script</button>
            <button type="button" data-action="delete-script" data-id="${esc(script.id)}" data-name="${esc(script.name)}" class="rounded-lg border border-rose-900 px-3 py-2 text-xs text-rose-200">Delete</button>
          </div>
        </aside>
      ` : `<p class="text-sm text-slate-400">Create a script to start a talk track.</p>`}
    </div>
  `;
}

function renderAnalytics() {
  const stats = state.stats;
  if (!stats) return `<p>Loading…</p>`;
  const cards = [
    ["Leads", stats.leads.total],
    ["In queue", stats.leads.inQueue],
    ["Calls today", stats.calls.today],
    ["Conversion", percent(stats.conversionRate)],
    ["Connect rate", percent(stats.connectRate)],
    ["Avg duration", formatDuration(stats.calls.averageDurationSeconds)],
  ];
  return `
    <h1 class="text-lg font-semibold text-white">Analytics & history</h1>
    <section class="mt-4 grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
      ${cards.map(([label, value]) => `<article class="rounded-xl border border-line bg-panel px-3 py-3"><p class="text-[11px] uppercase text-slate-500">${label}</p><p class="mt-2 text-2xl font-semibold text-white">${esc(value)}</p></article>`).join("")}
    </section>
    <section class="mt-4 overflow-x-auto rounded-2xl border border-line">
      <table class="min-w-full text-left text-sm">
        <thead class="text-[11px] uppercase tracking-wide text-slate-500"><tr>
          <th class="px-3 py-3">When</th><th class="px-3 py-3">Lead</th><th class="px-3 py-3">Campaign</th><th class="px-3 py-3">Outcome</th><th class="px-3 py-3">Duration</th><th class="px-3 py-3">Notes</th>
        </tr></thead>
        <tbody class="divide-y divide-line">
          ${state.logs.length ? state.logs.map((log) => `
            <tr>
              <td class="px-3 py-3 text-slate-400">${esc(formatWhen(log.endedAt))}</td>
              <td class="px-3 py-3">${esc(log.leadName)}</td>
              <td class="px-3 py-3 text-slate-400">${esc(log.campaignName || "—")}</td>
              <td class="px-3 py-3">${esc(STATUS_LABELS[log.outcome] || log.outcome)}</td>
              <td class="px-3 py-3 font-mono">${formatDuration(log.durationSeconds)}</td>
              <td class="px-3 py-3 max-w-xs truncate text-slate-300">${esc(log.notes || "")}</td>
            </tr>
          `).join("") : `<tr><td colspan="6" class="px-3 py-8 text-center text-slate-500">No calls yet.</td></tr>`}
        </tbody>
      </table>
    </section>
  `;
}

function mailStatus(status) {
  return { draft: "Draft", local: "Local outbox", sent: "Sent via SMTP", failed: "Not sent", queued: "Sending", received: "Reply" }[status] || status;
}

function triggerLabel(key) {
  return { no_answer: "No-answer follow-up", voicemail: "Voicemail follow-up", idle: "3-day idle", demo: "Demo ask" }[key] || "";
}

function folderCount(id, summary) {
  if (!summary) return 0;
  if (id === "all") return summary.threads;
  if (id === "needs_reply") return summary.needsReply;
  if (id === "triggers") return summary.triggers.active;
  if (id === "drafts") return summary.drafts;
  if (id === "sent") return summary.sent;
  if (id === "paused") return summary.paused;
  if (summary.triggers[id] !== undefined) return summary.triggers[id];
  return 0;
}

async function loadInbox() {
  const params = new URLSearchParams({ folder: state.inboxFolder });
  if (state.inboxSearch.trim()) params.set("search", state.inboxSearch.trim());
  const data = await api(`/api/inbox?${params}`);
  state.inboxThreads = data.threads;
  state.inboxSuggestions = data.suggestions;
  state.inboxSummary = data.summary;
  state.inboxSnippets = data.snippets;
  if (state.stats) state.stats.inbox = { unread: data.summary.unread, drafts: data.summary.drafts };
  if (state.inboxId && !state.composing) state.inboxDetail = await api(`/api/inbox/threads/${state.inboxId}`);
}

function renderInbox() {
  const summary = state.inboxSummary || { unread: 0, threads: 0, drafts: 0, replyRate: 0, smtpConfigured: false, triggers: {} };
  const detail = state.inboxDetail;
  const thread = detail?.thread;
  const lead = detail?.lead;
  return `
    <section class="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-lg font-semibold text-white">Email outreach &amp; inbox</h1>
        <p class="mt-1 text-xs text-slate-400">${summary.smtpConfigured ? `SMTP ready · ${esc(summary.fromEmail || "from address missing")}` : "Local outbox · add SMTP on the left when you want messages delivered"}</p>
      </div>
      <div class="flex flex-wrap gap-2 text-xs">
        <span class="rounded-lg border border-line px-3 py-2">${summary.threads} threads</span>
        <span class="rounded-lg border border-line px-3 py-2">${summary.unread} unread</span>
        <span class="rounded-lg border border-line px-3 py-2">${summary.triggers?.active || 0} triggers</span>
        <span class="rounded-lg border border-line px-3 py-2">${percent(summary.replyRate)} reply rate</span>
        <button type="button" data-action="compose-mail" class="rounded-lg bg-mint px-3 py-2 font-semibold text-ink">Compose</button>
      </div>
    </section>
    <div class="grid items-start gap-3 xl:grid-cols-[220px_320px_minmax(0,1fr)]">
      <aside class="rounded-2xl border border-line bg-panel p-3">
        <p class="px-2 text-[10px] uppercase tracking-wide text-slate-500">Mailboxes</p>
        <div class="mt-2 space-y-1">
          ${MAIL_FOLDERS.map(([id, label]) => `
            <button type="button" data-action="inbox-folder" data-folder="${id}" class="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-sm ${state.inboxFolder === id ? "bg-emerald-950/40 text-mint" : "text-slate-300 hover:bg-ink"}">
              <span>${label}</span><span class="font-mono text-[10px] text-slate-500">${folderCount(id, summary)}</span>
            </button>
          `).join("")}
        </div>
        <form id="mail-settings" class="mt-4 space-y-2 border-t border-line pt-3">
          <p class="text-[10px] uppercase tracking-wide text-slate-500">Sending</p>
          <input name="mailFromName" class="field text-xs" placeholder="From name" value="${esc(state.settings.mailFromName || "")}">
          <input name="mailFromEmail" class="field text-xs" placeholder="From email" value="${esc(state.settings.mailFromEmail || "")}">
          <input name="smtpHost" class="field text-xs" placeholder="SMTP host" value="${esc(state.settings.smtpHost || "")}">
          <div class="flex gap-2">
            <input name="smtpPort" class="field text-xs" placeholder="587" value="${esc(state.settings.smtpPort || "")}">
            <input name="smtpUser" class="field text-xs" placeholder="SMTP user" value="${esc(state.settings.smtpUser || "")}">
          </div>
          <input name="smtpPass" type="password" class="field text-xs" placeholder="${state.settings.smtpConfigured ? "Password saved" : "SMTP password"}">
          <button type="button" data-action="save-mailbox" class="rounded-lg border border-line px-2 py-1 text-xs">Save mailbox</button>
        </form>
      </aside>
      <section class="rounded-2xl border border-line bg-panel">
        <div class="border-b border-line p-3">
          <input id="inbox-search" value="${esc(state.inboxSearch)}" class="field text-sm" placeholder="Search contact, company, or subject">
        </div>
        <div class="max-h-[640px] overflow-y-auto">
          ${state.inboxSuggestions.map((item) => `
            <button type="button" data-action="draft-idle" data-id="${esc(item.leadId)}" class="block w-full border-b border-line px-3 py-3 text-left hover:bg-white/5">
              <span class="text-sm font-medium text-white">${esc(item.name)}</span>
              <span class="mt-1 block text-xs text-slate-400">${esc(item.company || item.email)} · no recent touch</span>
              <span class="mt-1 block text-[11px] text-amber-200">Create idle follow-up draft</span>
            </button>
          `).join("")}
          ${state.inboxThreads.length ? state.inboxThreads.map((item) => `
            <button type="button" data-action="open-thread" data-id="${esc(item.id)}" class="block w-full border-b border-line px-3 py-3 text-left hover:bg-white/5 ${state.inboxId === item.id && !state.composing ? "bg-emerald-950/20" : ""}">
              <span class="flex items-center justify-between gap-2">
                <span class="truncate text-sm font-medium text-white">${esc(item.leadName || item.subject || "No subject")}</span>
                <span class="shrink-0 font-mono text-[10px] text-slate-500">${esc(formatWhen(item.updatedAt))}</span>
              </span>
              <span class="mt-1 block truncate text-xs text-slate-300">${esc(item.subject)}</span>
              <span class="mt-1 block truncate text-xs text-slate-500">${esc(item.preview)}</span>
              <span class="mt-2 flex flex-wrap gap-1">
                ${item.unread ? `<span class="rounded bg-amber-950 px-1.5 py-0.5 text-[10px] text-amber-200">Unread</span>` : ""}
                ${item.triggerKey ? `<span class="rounded bg-sky-950 px-1.5 py-0.5 text-[10px] text-sky-200">${esc(triggerLabel(item.triggerKey))}</span>` : ""}
                <span class="rounded bg-ink px-1.5 py-0.5 text-[10px] text-slate-400">${esc(mailStatus(item.latestStatus))}</span>
                ${item.triggersPaused ? `<span class="rounded bg-rose-950 px-1.5 py-0.5 text-[10px] text-rose-200">Paused</span>` : ""}
              </span>
            </button>
          `).join("") : `<p class="px-3 py-8 text-sm text-slate-500">${state.inboxSuggestions.length ? "" : "Nothing in this folder. Compose a message, or log a no-answer on a lead that has an email address."}</p>`}
        </div>
      </section>
      <section class="rounded-2xl border border-line bg-panel p-4">
        ${state.composing ? renderComposer() : thread ? renderThread(thread, lead, detail) : `<div class="px-2 py-16 text-center text-sm text-slate-500">Select a thread, or compose a new one.</div>`}
      </section>
    </div>
  `;
}

function renderComposer() {
  return `
    <h2 class="text-base font-semibold text-white">New message</h2>
    <div class="mt-3 space-y-2">
      <select id="mail-lead" class="field text-sm">
        <option value="">No lead</option>
        ${state.leads.map((lead) => `<option value="${esc(lead.id)}">${esc(lead.name)}${lead.email ? ` · ${esc(lead.email)}` : ""}</option>`).join("")}
      </select>
      <input id="mail-to" class="field text-sm" placeholder="To">
      <input id="mail-subject" class="field text-sm" placeholder="Subject">
      <textarea id="mail-body" rows="8" class="field text-sm" placeholder="Write the note. {{first_name}} and {{company}} are filled when a lead is attached."></textarea>
      <select id="mail-snippet" class="field text-sm">
        <option value="">Insert snippet</option>
        ${state.inboxSnippets.map((snippet) => `<option value="${esc(snippet.id)}">${esc(snippet.name)}</option>`).join("")}
      </select>
      <label class="flex items-center gap-2 text-xs text-slate-300"><input id="mail-pause" type="checkbox" checked> Pause later follow-up drafts for this lead</label>
      <div class="flex flex-wrap gap-2">
        <button type="button" data-action="save-mail" data-send="false" class="rounded-lg border border-line px-3 py-2 text-sm">Save draft</button>
        <button type="button" data-action="save-mail" data-send="true" class="rounded-lg bg-mint px-3 py-2 text-sm font-semibold text-ink">Send</button>
        <button type="button" data-action="close-compose" class="rounded-lg px-3 py-2 text-sm text-slate-400">Cancel</button>
      </div>
      <p class="text-[11px] leading-5 text-slate-500">${state.inboxSummary?.smtpConfigured ? "Send delivers through the SMTP host you saved." : "Without an SMTP host, Send keeps the message in the local outbox. It is not delivered to the recipient."}</p>
    </div>
  `;
}

function renderThread(thread, lead, detail) {
  const url = lead?.phone ? voiceUrl(lead.phone) : "";
  return `
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p class="text-xs text-slate-500">${esc(lead?.title || "")} ${lead?.company ? `· ${esc(lead.company)}` : ""}</p>
        <h2 class="text-xl font-semibold text-white">${esc(thread.leadName || thread.subject)}</h2>
        <p class="mt-1 text-sm text-slate-400">${esc(thread.subject)}</p>
      </div>
      <div class="flex flex-wrap gap-2">
        ${url ? `<a data-action="dial-row" data-id="${esc(lead.id)}" href="${esc(url)}" target="_blank" rel="noopener" class="rounded-lg bg-mint px-3 py-2 text-xs font-semibold text-ink">Call ${esc(formatPhone(lead.phone))}</a>` : ""}
        <button type="button" data-action="book-demo" class="rounded-lg border border-line px-3 py-2 text-xs">Book demo draft</button>
      </div>
    </div>
    <p class="mt-3 text-xs text-slate-400">${thread.triggersPaused ? "Follow-up drafts are paused for this lead." : thread.triggerKey ? `${esc(triggerLabel(thread.triggerKey))} is active. A reply pauses later drafts.` : "Manual thread."}</p>
    <div class="mt-4 space-y-3">
      ${detail.messages.map((message) => `
        <article class="rounded-xl border px-3 py-3 ${message.direction === "inbound" ? "border-amber-900/60 bg-amber-950/20" : "border-line bg-ink/40"}">
          <p class="text-[11px] uppercase tracking-wide text-slate-500">${message.direction === "inbound" ? "Reply" : "Outbound"} · ${esc(mailStatus(message.status))} · ${esc(formatWhen(message.sentAt || message.createdAt))}</p>
          <p class="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-100">${esc(message.body)}</p>
          ${message.error ? `<p class="mt-2 text-xs text-rose-300">${esc(message.error)}</p>` : ""}
        </article>
      `).join("")}
    </div>
    <div class="mt-4 space-y-2 border-t border-line pt-4">
      <textarea id="reply-body" rows="4" class="field text-sm" placeholder="Write a reply"></textarea>
      <label class="flex items-center gap-2 text-xs text-slate-300"><input id="reply-pause" type="checkbox" checked> Pause later follow-up drafts when this sends</label>
      <div class="flex flex-wrap gap-2">
        <button type="button" data-action="reply-mail" data-send="false" class="rounded-lg border border-line px-3 py-2 text-xs">Save draft</button>
        <button type="button" data-action="reply-mail" data-send="true" class="rounded-lg bg-mint px-3 py-2 text-xs font-semibold text-ink">Send</button>
        <button type="button" data-action="toggle-triggers" class="rounded-lg border border-line px-3 py-2 text-xs">${thread.triggersPaused ? "Resume triggers" : "Pause triggers"}</button>
        <button type="button" data-action="delete-thread" class="rounded-lg border border-rose-900 px-3 py-2 text-xs text-rose-200">Delete</button>
      </div>
      <textarea id="inbound-body" rows="3" class="field text-sm" placeholder="Paste a reply you received outside MyDial"></textarea>
      <button type="button" data-action="log-reply" class="rounded-lg border border-line px-3 py-2 text-xs">Log inbound reply</button>
    </div>
    ${detail.journey?.length ? `
      <div class="mt-4 border-t border-line pt-4">
        <h3 class="text-sm font-semibold text-white">Journey</h3>
        <div class="mt-2 space-y-2">
          ${detail.journey.map((item) => `
            <p class="text-xs text-slate-300">
              <span class="text-slate-500">${esc(formatWhen(item.at))}</span>
              ${item.kind === "call" ? ` Call · ${esc(STATUS_LABELS[item.outcome] || item.outcome)} · ${formatDuration(item.durationSeconds)}` : ` Email · ${item.direction === "inbound" ? "Reply" : esc(mailStatus(item.status))}${item.triggerKey ? ` · ${esc(triggerLabel(item.triggerKey))}` : ""}`}
            </p>
          `).join("")}
        </div>
      </div>
    ` : ""}
  `;
}

function renderConfig() {
  const health = state.health;
  const kb = health ? (health.sqlite.bytes / 1024).toFixed(1) : "—";
  return `
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-lg font-semibold text-white">API & Docker</h1>
        <p class="mt-1 text-xs text-slate-400">Local only. No cloud database.</p>
      </div>
      <a href="/api/docs" target="_blank" rel="noopener" class="rounded-lg bg-mint px-3 py-2 text-sm font-semibold text-ink">Open Swagger</a>
    </div>
    <section class="mt-4 grid gap-3 md:grid-cols-4">
      <article class="rounded-xl border border-line bg-panel p-3"><p class="text-[11px] uppercase text-slate-500">Daemon</p><p class="mt-1 font-mono text-sm text-mint">http://localhost:${health?.port || 3000}</p></article>
      <article class="rounded-xl border border-line bg-panel p-3"><p class="text-[11px] uppercase text-slate-500">SQLite</p><p class="mt-1 font-mono text-sm">${kb} KB</p><p class="truncate text-[11px] text-slate-500">${esc(health?.sqlite.path || "")}</p></article>
      <article class="rounded-xl border border-line bg-panel p-3"><p class="text-[11px] uppercase text-slate-500">Node</p><p class="mt-1 font-mono text-sm">${esc(health?.node || "")}</p></article>
      <article class="rounded-xl border border-line bg-panel p-3"><p class="text-[11px] uppercase text-slate-500">Uptime</p><p class="mt-1 font-mono text-sm">${formatClock((health?.uptimeSeconds || 0) * 1000)}</p></article>
    </section>
    <div class="mt-4 grid gap-4 xl:grid-cols-2">
      <article class="rounded-2xl border border-line bg-panel p-4">
        <h2 class="text-sm font-semibold">Docker</h2>
        <pre class="mt-3 overflow-x-auto rounded-lg bg-ink p-3 font-mono text-xs text-mint">docker compose up --build -d</pre>
        <dl class="mt-3 space-y-1 text-xs text-slate-400">
          <div>Image port <span class="text-slate-200">3000</span></div>
          <div>Volume <span class="text-slate-200">/data/mydial.db</span></div>
          <div>Restart <span class="text-slate-200">unless-stopped</span></div>
        </dl>
        <h3 class="mt-4 text-sm font-semibold">Voice link</h3>
        <p class="mt-1 break-all font-mono text-[11px] text-slate-400">${esc(health?.googleVoicePrefix || "")}</p>
        <label class="mt-3 block text-xs text-slate-400">Line label<input id="gv-line" class="field mt-1" value="${esc(state.settings.gvLine || "")}" placeholder="+1 ..."></label>
        <label class="mt-3 flex items-center gap-2 text-xs"><input id="clipboard-fallback" type="checkbox" ${state.settings.clipboardFallback ? "checked" : ""}> Copy the number if the new tab is blocked</label>
        <button type="button" data-action="save-settings" class="mt-3 rounded-lg bg-mint px-3 py-2 text-sm font-semibold text-ink">Save</button>
        <h3 class="mt-5 text-sm font-semibold">Models</h3>
        <p class="mt-1 text-xs text-slate-400">${esc(coachPrivacy())}</p>
        <div class="mt-3 grid gap-2">
          <label class="text-xs text-slate-400">Chat provider
            <select id="llm-provider" class="field mt-1">
              ${["ollama", "openai", "anthropic", "compatible"].map((provider) => `<option value="${provider}" ${state.settings.llmProvider === provider ? "selected" : ""}>${provider}</option>`).join("")}
            </select>
          </label>
          <label class="text-xs text-slate-400">Chat base URL<input id="llm-base" class="field mt-1" value="${esc(state.settings.llmBaseUrl || "")}" placeholder="http://127.0.0.1:11434/v1"></label>
          <label class="text-xs text-slate-400">Model during the call<input id="llm-live-model" class="field mt-1" value="${esc(state.settings.llmLiveModel || "")}" placeholder="qwen3.5:4b-mlx"></label>
          <label class="text-xs text-slate-400">Model after the call<input id="llm-review-model" class="field mt-1" value="${esc(state.settings.llmReviewModel || "")}" placeholder="qwen3.5:9b-mlx"></label>
          <label class="text-xs text-slate-400">Chat API key<input id="llm-key" type="password" class="field mt-1" placeholder="${state.settings.llmApiKeySet ? "Saved — leave blank to keep" : "sk-..."}"></label>
          <label class="text-xs text-slate-400">Transcription
            <select id="stt-mode" class="field mt-1">
              <option value="local" ${state.settings.sttMode !== "remote" ? "selected" : ""}>In this browser (Whisper)</option>
              <option value="remote" ${state.settings.sttMode === "remote" ? "selected" : ""}>OpenAI-compatible URL</option>
            </select>
          </label>
          <label class="text-xs text-slate-400">Browser Whisper model
            <select id="whisper-model" class="field mt-1">
              ${["Xenova/whisper-tiny.en", "Xenova/whisper-base.en", "Xenova/whisper-small.en"].map((model) => `<option value="${model}" ${state.settings.whisperModel === model ? "selected" : ""}>${model.split("/")[1]}</option>`).join("")}
            </select>
          </label>
          <label class="text-xs text-slate-400">Transcription URL<input id="stt-base" class="field mt-1" value="${esc(state.settings.sttBaseUrl || "")}"></label>
          <label class="text-xs text-slate-400">Transcription model<input id="stt-model" class="field mt-1" value="${esc(state.settings.sttModel || "")}"></label>
          <label class="text-xs text-slate-400">Transcription API key<input id="stt-key" type="password" class="field mt-1" placeholder="${state.settings.sttApiKeySet ? "Saved — leave blank to keep" : "Optional if the chat key is the same"}"></label>
          <label class="text-xs text-slate-400">Embeddings
            <select id="embed-provider" class="field mt-1">
              ${["none", "openai", "ollama", "compatible"].map((provider) => `<option value="${provider}" ${(state.settings.embedProvider || "none") === provider ? "selected" : ""}>${provider === "none" ? "Full-text search only" : provider}</option>`).join("")}
            </select>
          </label>
          <label class="text-xs text-slate-400">Embedding URL<input id="embed-base" class="field mt-1" value="${esc(state.settings.embedBaseUrl || "")}" placeholder="Blank uses the provider default"></label>
          <label class="text-xs text-slate-400">Embedding model<input id="embed-model" class="field mt-1" value="${esc(state.settings.embedModel || "")}" placeholder="text-embedding-3-small"></label>
          <label class="text-xs text-slate-400">Embedding API key<input id="embed-key" type="password" class="field mt-1" placeholder="${state.settings.embedApiKeySet ? "Saved — leave blank to keep" : "Optional if the chat key is the same"}"></label>
        </div>
        <button type="button" data-action="save-models" class="mt-3 rounded-lg bg-mint px-3 py-2 text-sm font-semibold text-ink">Save models</button>
        <label class="mt-4 block text-xs text-slate-400">Dial test<input id="dial-test" class="field mt-1" placeholder="(555) 010-0000"></label>
        <button type="button" data-action="dial-test" class="mt-2 rounded-lg border border-line px-3 py-2 text-xs">Open test link</button>
        <p id="dial-test-url" class="mt-2 break-all font-mono text-[11px] text-slate-500"></p>
      </article>
      <article class="rounded-2xl border border-line bg-panel p-4">
        <h2 class="text-sm font-semibold">Try the API</h2>
        <div class="mt-3 flex gap-2">
          <select id="api-path" class="field">
            ${["/api/health", "/api/leads", "/api/queue/next", "/api/inbox", "/api/campaigns", "/api/scripts", "/api/call-logs", "/api/stats", "/api/webhooks"].map((path) => `<option ${state.apiPath === path ? "selected" : ""}>${path}</option>`).join("")}
          </select>
          <button type="button" data-action="send-api" class="rounded-lg bg-mint px-3 py-2 text-sm font-semibold text-ink">Send</button>
        </div>
        <pre class="mt-3 max-h-80 overflow-auto rounded-lg bg-ink p-3 font-mono text-[11px] text-emerald-100">${esc(state.apiResult || "Response appears here.")}</pre>
      </article>
    </div>
    <div class="mt-4">
      <article class="rounded-2xl border border-line bg-panel p-4">
        <h2 class="text-sm font-semibold">Webhooks</h2>
        <p class="mt-1 text-xs text-slate-400">MyDial POSTs <span class="font-mono">{ event, sentAt, data }</span> when something happens. A secret adds an HMAC SHA-256 header named X-MyDial-Signature.</p>
        <div class="mt-3 grid gap-2">
          <input id="webhook-name" class="field" placeholder="Name">
          <input id="webhook-url" class="field" placeholder="https://example.com/hooks/mydial">
          <input id="webhook-secret" class="field" placeholder="Signing secret (optional)">
        </div>
        <div class="mt-3 flex flex-wrap gap-2">
          ${WEBHOOK_EVENTS.map(([id, label]) => `<label class="flex items-center gap-1 rounded-full border border-line px-2 py-1 text-[11px]"><input data-webhook-event type="checkbox" value="${id}" checked> ${label}</label>`).join("")}
        </div>
        <button type="button" data-action="save-webhook" class="mt-3 rounded-lg bg-mint px-3 py-2 text-sm font-semibold text-ink">Add webhook</button>
        <div class="mt-4 space-y-2">
          ${state.webhooks.length ? state.webhooks.map((hook) => `
            <div class="rounded-xl border border-line px-3 py-2 text-xs">
              <div class="flex items-start justify-between gap-2">
                <div>
                  <p class="font-medium text-white">${esc(hook.name)}</p>
                  <p class="break-all font-mono text-[11px] text-slate-400">${esc(hook.url)}</p>
                  <p class="mt-1 text-slate-500">${hook.events.length ? esc(hook.events.join(", ")) : "All events"}${hook.hasSecret ? " · signed" : ""}</p>
                </div>
                <div class="flex gap-2">
                  <button type="button" data-action="test-webhook" data-id="${esc(hook.id)}" class="text-mint">Test</button>
                  <button type="button" data-action="delete-webhook" data-id="${esc(hook.id)}" class="text-rose-300">Delete</button>
                </div>
              </div>
              ${(hook.deliveries || []).map((delivery) => `<p class="mt-1 text-slate-500">${esc(delivery.event)} · ${esc(delivery.status)}${delivery.responseCode ? ` · ${delivery.responseCode}` : ""}${delivery.error ? ` · ${esc(delivery.error)}` : ""}</p>`).join("")}
            </div>
          `).join("") : `<p class="text-xs text-slate-500">No webhooks yet.</p>`}
        </div>
      </article>
    </div>
  `;
}

function openModal(html) {
  const modal = document.getElementById("modal");
  modal.innerHTML = `<div class="max-h-full w-full max-w-lg overflow-y-auto rounded-2xl border border-line bg-panel p-5">${html}</div>`;
  modal.classList.remove("hidden");
  modal.classList.add("flex");
}

function closeModal() {
  const modal = document.getElementById("modal");
  modal.classList.add("hidden");
  modal.classList.remove("flex");
  modal.innerHTML = "";
}

function leadForm(lead) {
  openModal(`
    <form id="lead-form" class="space-y-3">
      <h2 class="text-xl font-semibold text-white">${lead ? "Edit lead" : "Quick add"}</h2>
      <label class="block text-xs">Name<input name="name" required class="field mt-1" value="${esc(lead?.name || "")}"></label>
      <label class="block text-xs">Title<input name="title" class="field mt-1" value="${esc(lead?.title || "")}"></label>
      <label class="block text-xs">Phone<input name="phone" required class="field mt-1" value="${esc(lead ? formatPhone(lead.phone) : "")}"></label>
      <label class="block text-xs">Company<input name="company" class="field mt-1" value="${esc(lead?.company || "")}"></label>
      <label class="block text-xs">Email<input name="email" class="field mt-1" value="${esc(lead?.email || "")}"></label>
      <label class="block text-xs">Timezone<input name="timezone" class="field mt-1" placeholder="America/New_York" value="${esc(lead?.timezone || "")}"></label>
      <label class="block text-xs">Tags<input name="tags" class="field mt-1" value="${esc(lead?.tags || "")}"></label>
      <label class="block text-xs">Campaign
        <select name="campaignId" class="field mt-1">
          <option value="">No campaign</option>
          ${state.campaigns.map((campaign) => `<option value="${esc(campaign.id)}" ${(lead ? lead.campaignId : state.campaignFilter) === campaign.id ? "selected" : ""}>${esc(campaign.name)}</option>`).join("")}
        </select>
      </label>
      <label class="block text-xs">Notes<textarea name="notes" rows="3" class="field mt-1">${esc(lead?.notes || "")}</textarea></label>
      <p id="form-error" class="hidden text-sm text-rose-300"></p>
      <div class="flex justify-end gap-2">
        <button type="button" data-action="close-modal" class="rounded-lg px-3 py-2 text-sm">Cancel</button>
        <button type="submit" class="rounded-lg bg-mint px-3 py-2 text-sm font-semibold text-ink">Save</button>
      </div>
    </form>
  `);
  document.getElementById("lead-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.currentTarget));
    if (!payload.campaignId) payload.campaignId = null;
    try {
      if (lead) await api(`/api/leads/${lead.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      else await api("/api/leads", { method: "POST", body: JSON.stringify(payload) });
      closeModal();
      showToast(lead ? "Lead updated" : "Lead added");
      await refreshCore();
      await showView(state.view);
    } catch (error) {
      const box = document.getElementById("form-error");
      box.textContent = error.message;
      box.classList.remove("hidden");
    }
  });
}

function campaignForm() {
  openModal(`
    <form id="campaign-form" class="space-y-3">
      <h2 class="text-xl font-semibold text-white">New campaign</h2>
      <label class="block text-xs">Name<input name="name" required class="field mt-1"></label>
      <label class="block text-xs">Description<textarea name="description" rows="3" class="field mt-1"></textarea></label>
      <label class="block text-xs">Script
        <select name="scriptId" class="field mt-1"><option value="">No script</option>${state.scripts.map((script) => `<option value="${esc(script.id)}">${esc(script.name)}</option>`).join("")}</select>
      </label>
      <p id="form-error" class="hidden text-sm text-rose-300"></p>
      <div class="flex justify-end gap-2">
        <button type="button" data-action="close-modal" class="rounded-lg px-3 py-2 text-sm">Cancel</button>
        <button type="submit" class="rounded-lg bg-mint px-3 py-2 text-sm font-semibold text-ink">Create</button>
      </div>
    </form>
  `);
  document.getElementById("campaign-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const created = await api("/api/campaigns", { method: "POST", body: JSON.stringify(payload) });
      closeModal();
      state.builderId = created.id;
      await refreshCore();
      await showView("campaigns");
    } catch (error) {
      const box = document.getElementById("form-error");
      box.textContent = error.message;
      box.classList.remove("hidden");
    }
  });
}

function importForm() {
  openModal(`
    <form id="import-form" class="space-y-3">
      <h2 class="text-xl font-semibold text-white">Import CSV</h2>
      <p class="text-xs text-slate-400">Header row with name and phone. Optional: title, company, email, notes, timezone, tags.</p>
      <label class="block text-xs">Campaign<select name="campaignId" class="field mt-1"><option value="">No campaign</option>${state.campaigns.map((campaign) => `<option value="${esc(campaign.id)}">${esc(campaign.name)}</option>`).join("")}</select></label>
      <input name="file" type="file" accept=".csv,text/csv" class="text-sm">
      <textarea name="csv" rows="5" class="field" placeholder="name,phone,company"></textarea>
      <p id="form-error" class="hidden text-sm text-rose-300"></p>
      <div class="flex justify-end gap-2">
        <button type="button" data-action="close-modal" class="rounded-lg px-3 py-2 text-sm">Cancel</button>
        <button type="submit" class="rounded-lg bg-mint px-3 py-2 text-sm font-semibold text-ink">Import</button>
      </div>
    </form>
  `);
  document.getElementById("import-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const file = form.file.files[0];
    const csv = file ? await file.text() : form.csv.value;
    try {
      const result = await api("/api/leads/import", { method: "POST", body: JSON.stringify({ csv, campaignId: form.campaignId.value || null }) });
      closeModal();
      showToast(`Imported ${result.created}`);
      await refreshCore();
      await showView("leads");
    } catch (error) {
      const box = document.getElementById("form-error");
      box.textContent = error.message;
      box.classList.remove("hidden");
    }
  });
}

function scriptForm() {
  openModal(`
    <form id="new-script-form" class="space-y-3">
      <h2 class="text-xl font-semibold text-white">New script</h2>
      <label class="block text-xs">Name<input name="name" required class="field mt-1"></label>
      <label class="block text-xs">Opening<textarea name="body" rows="4" class="field mt-1" placeholder="Hi {{first_name}}, this is a quick call about {{company}}."></textarea></label>
      <p id="form-error" class="hidden text-sm text-rose-300"></p>
      <div class="flex justify-end gap-2">
        <button type="button" data-action="close-modal" class="rounded-lg px-3 py-2 text-sm">Cancel</button>
        <button type="submit" class="rounded-lg bg-mint px-3 py-2 text-sm font-semibold text-ink">Create</button>
      </div>
    </form>
  `);
  document.getElementById("new-script-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.currentTarget));
    payload.sections = [{ label: "Opening", text: payload.body }];
    try {
      const created = await api("/api/scripts", { method: "POST", body: JSON.stringify(payload) });
      closeModal();
      state.scriptId = created.id;
      await refreshCore();
      await showView("scripts");
    } catch (error) {
      const box = document.getElementById("form-error");
      box.textContent = error.message;
      box.classList.remove("hidden");
    }
  });
}

function readCadenceFromDom(campaign) {
  const cadence = structuredClone(campaign.cadence);
  const index = state.stepIndex || 0;
  const step = cadence.steps[index];
  const label = document.getElementById("step-label");
  if (step && label) {
    if (step.type === "followup") step.subject = label.value;
    else step.label = label.value;
  }
  const body = document.getElementById("step-body");
  if (step && body) step.body = body.value;
  const hours = document.getElementById("step-hours");
  if (step && hours) step.hours = Number(hours.value || 0);
  cadence.maxAttempts = Number(document.getElementById("cadence-attempts").value || 3);
  cadence.retryMinutes = Number(document.getElementById("cadence-retry").value || 0);
  cadence.windowStart = document.getElementById("cadence-start").value || "09:00";
  cadence.windowEnd = document.getElementById("cadence-end").value || "16:30";
  cadence.skipWeekends = document.getElementById("cadence-weekends").checked;
  cadence.autoAdvance = document.getElementById("cadence-advance").checked;
  const scriptId = document.getElementById("cadence-script").value || null;
  const status = document.getElementById("cadence-status").value;
  return { cadence, scriptId, status };
}

function readScriptFromDom() {
  const sections = [...document.querySelectorAll("[data-section]")].map((row) => ({
    label: row.querySelector("[data-section-label]").value,
    text: row.querySelector("[data-section-text]").value,
  }));
  const objections = [...document.querySelectorAll("[data-objection]")].map((row) => ({
    label: row.querySelector("[data-objection-label]").value,
    response: row.querySelector("[data-objection-response]").value,
  }));
  return { name: document.getElementById("script-name").value, sections, objections };
}

function requestCallMedia() {
  if (!navigator.mediaDevices?.getUserMedia) {
    return { mic: Promise.reject(new Error("This browser cannot use the microphone.")), tab: Promise.resolve(null) };
  }
  return {
    mic: navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } }),
    tab: navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).catch(() => null),
  };
}

function enqueueClip(clip) {
  clipChain = clipChain.then(() => sendClip(clip)).catch((error) => {
    state.coachStatus = error.message;
    paintCoach();
  });
}

async function sendClip(clip) {
  const started = Date.now();
  while (!state.coachSession && Date.now() - started < 8000) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  if (!state.coachLiveId && (!state.coachSession || state.coachSession.endedAt)) return;
  const sessionId = state.coachLiveId || state.coachSession.id;
  const listen = await import("/listen.js");
  let text = "";
  if ((state.settings.sttMode || "local") !== "remote") {
    text = await listen.transcribeLocal(clip.samples, clip.sampleRate, state.settings.whisperModel, (status) => {
      state.coachStatus = status;
      paintCoach();
    });
  }
  const audio = listen.resample(clip.samples, clip.sampleRate, 16000);
  const audioBase64 = listen.bytesToBase64(listen.encodeWav(audio, 16000));
  coachLiveText = "";
  const streamed = await consumeCoachStream(`/api/coach/sessions/${sessionId}/utterances`, {
    speaker: clip.speaker,
    text,
    audioBase64,
  }, coachStreamHandlers());
  state.coachStreaming = false;
  coachLiveText = "";
  if (state.coachSession?.id === sessionId && streamed.session) {
    state.coachSession = streamed.session;
    state.coachStatus = streamed.session.paused ? "Coach paused. The transcript is still listening." : (captureHandle?.mixed ? "Microphone only. Rename a line if that was you." : "Listening.");
    paintCoach();
  }
}

function beginCoach(lead) {
  const media = captureHandle ? null : requestCallMedia();
  state.coachPin = false;
  state.coachStatus = "Starting the coach…";
  const sessionPromise = api("/api/coach/sessions", { method: "POST", body: JSON.stringify({ leadId: lead.id }) });
  return (async () => {
    try {
      const session = await sessionPromise;
      state.coachSession = session;
      state.coachLiveId = session.id;
      state.coachPin = false;
      parkedCoach = null;
      if (media) {
        const listen = await import("/listen.js");
        captureHandle = await listen.attachMedia(media, {
          onClip: enqueueClip,
          onStatus: (status) => {
            state.coachStatus = status;
            paintCoach();
          },
        });
        if (captureHandle.mixed) state.coachStatus = "Microphone only. Lines start as Prospect until you rename them.";
      }
      paintCoach();
    } catch (error) {
      state.coachStatus = error.message;
      if (media?.mic) media.mic.then((stream) => stream.getTracks().forEach((track) => track.stop())).catch(() => {});
      if (media?.tab) media.tab.then((stream) => stream?.getTracks?.().forEach((track) => track.stop())).catch(() => {});
      paintCoach();
    }
  })();
}

function stopCallCapture() {
  captureHandle?.stop?.();
  captureHandle = null;
  state.coachLiveId = null;
}

async function onDial(lead = state.queue.lead) {
  if (!lead || state.paused) return;
  startTimer(lead.id);
  paintTimer();
  const listening = beginCoach(lead);
  if (state.settings.clipboardFallback) {
    navigator.clipboard?.writeText(e164(lead.phone)).catch(() => {});
  }
  try {
    const updated = await api(`/api/leads/${lead.id}/dial`, { method: "POST" });
    if (state.queue.lead?.id === lead.id) {
      state.queue.lead.attempts = updated.attempts;
      state.queue.lead.lastCalledAt = updated.lastCalledAt;
      state.session.dials += 1;
    }
    const count = document.getElementById("attempt-count");
    if (count && state.queue.lead?.id === lead.id) {
      count.textContent = `Attempts ${updated.attempts}${updated.lastCalledAt ? ` · last ${formatWhen(updated.lastCalledAt)}` : ""}`;
    }
    await listening;
  } catch (error) {
    showToast(error.message);
  }
}

function onNotesInput(value) {
  const lead = state.queue.lead;
  if (!lead) return;
  state.draftNotes = value;
  state.saveState = "saving";
  const label = document.getElementById("save-label");
  if (label) label.textContent = "Saving…";
  clearTimeout(notesTimer);
  const leadId = lead.id;
  notesTimer = setTimeout(async () => {
    try {
      await api(`/api/leads/${leadId}`, { method: "PATCH", body: JSON.stringify({ notes: state.draftNotes }) });
      state.saveState = "saved";
      if (state.queue.lead?.id === leadId) state.queue.lead.notes = state.draftNotes;
    } catch (error) {
      state.saveState = "error";
      showToast(error.message);
    }
    const current = document.getElementById("save-label");
    if (current && state.queue.lead?.id === leadId) current.textContent = state.saveState === "saved" ? "Saved" : "Could not save";
  }, 400);
}

function rememberProfileForm() {
  const form = document.getElementById("profile-form");
  if (!form) return;
  const data = Object.fromEntries(new FormData(form));
  state.profileDraft = { id: form.dataset.lead, ...data };
  state.profileDirty = true;
}

async function confirmDirtyProfile() {
  if (!state.profileDirty) return "discard";
  return askConfirm("This profile has unsaved edits.", [
    { id: "save", label: "Save" },
    { id: "discard", label: "Discard" },
    { id: "keep", label: "Keep editing" },
  ]);
}

async function saveProfile(confirmFirst = true) {
  const form = document.getElementById("profile-form");
  if (!form) return false;
  if (confirmFirst) {
    const choice = await askConfirm("Save these changes?", [
      { id: "save", label: "Save" },
      { id: "keep", label: "Keep editing" },
    ]);
    if (choice !== "save") return false;
  }
  const data = Object.fromEntries(new FormData(form));
  const leadId = form.dataset.lead;
  const current = state.queue?.lead?.id === leadId ? state.queue.lead : state.detail;
  const payload = {
    name: data.name,
    title: data.title,
    company: data.company,
    phone: data.phone,
    email: data.email,
    timezone: data.timezone,
    campaignId: data.campaignId,
  };
  if (!current || data.status !== current.status) payload.status = data.status;
  const updated = await api(`/api/leads/${leadId}`, { method: "PATCH", body: JSON.stringify(payload) });
  const full = await api(`/api/leads/${leadId}`);
  state.profileDirty = false;
  state.profileDraft = null;
  if (state.queue?.lead?.id === leadId) state.queue.lead = full;
  if (state.detail?.id === leadId) state.detail = full;
  showToast("Profile saved");
  if (updated) render();
  return true;
}

async function switchRecordTab(scope, tab) {
  if (recordTab(scope) === tab) return;
  if (recordTab(scope) === "profile" && state.profileDirty) {
    const choice = await confirmDirtyProfile();
    if (choice === "keep") return;
    if (choice === "save") {
      const saved = await saveProfile(false);
      if (!saved) return;
    }
    state.profileDirty = false;
    state.profileDraft = null;
  }
  if (scope === "leads") state.leadsTab = tab;
  else state.dialTab = tab;
  const lead = scope === "leads" ? state.detail : state.queue?.lead;
  if (tab === "notes" && lead) await loadRecordNotes(lead.id);
  if (tab === "chat" && lead) {
    try { await ensureCoachSession(lead); } catch (error) { showToast(error.message); }
  }
  render();
}

async function closeLeadModal() {
  if (state.profileDirty) {
    const choice = await confirmDirtyProfile();
    if (choice === "keep") return;
    if (choice === "save") {
      const saved = await saveProfile(false);
      if (!saved) return;
    }
  }
  state.profileDirty = false;
  state.profileDraft = null;
  state.leadModal = false;
  state.noteEdit = null;
  restoreParkedCoach();
  render();
}

async function onDisposition(outcome, leadId) {
  const queueLead = state.queue?.lead;
  const targetId = leadId || queueLead?.id;
  if (!targetId || state.busy) return;
  if (!leadId && state.view !== "dial") return;
  const onDialer = state.view === "dial" && queueLead?.id === targetId;
  const lead = onDialer ? queueLead : (state.detail?.id === targetId ? state.detail : null);
  const campaign = campaignById((lead || queueLead)?.campaignId);
  state.busy = true;
  clearTimeout(notesTimer);
  const timed = consumeTimer(targetId);
  const sessionId = onDialer ? (state.coachLiveId || (state.coachSession?.leadId === targetId ? state.coachSession.id : null)) : null;
  const viewingLive = onDialer && (!state.coachLiveId || state.coachSession?.id === state.coachLiveId);
  if (onDialer) stopCallCapture();
  const settle = clipChain;
  try {
    await api(`/api/leads/${targetId}/disposition`, {
      method: "POST",
      body: JSON.stringify({ outcome, durationSeconds: timed.durationSeconds, startedAt: timed.startedAt }),
    });
    if (onDialer) {
      state.session.talk += timed.durationSeconds;
      if (outcome === "positive" || outcome === "not_interested") state.session.connected += 1;
    }
    showToast(STATUS_LABELS[outcome] || outcome);
    if (sessionId) {
      void settle.finally(() => api(`/api/coach/sessions/${sessionId}/finish`, { method: "POST" }).catch(() => {}));
      try {
        const latest = await api(`/api/coach/sessions/${sessionId}`);
        if (viewingLive) {
          state.coachSession = latest;
          state.coachStatus = "Writing the review…";
        }
      } catch {
        /* the review still lands on the call */
      }
    }
    await refreshCore();
    if (state.view === "leads" && state.leadModal) {
      state.detail = await api(`/api/leads/${targetId}`);
      await loadRecordNotes(targetId);
      await loadLeads();
      render();
    } else if (campaign?.cadence?.autoAdvance === false) {
      state.queue.lead = await api(`/api/leads/${targetId}`);
      state.draftNotes = state.queue.lead.notes || "";
      await loadRecordNotes(targetId);
      render();
    } else {
      await showView("dial");
    }
  } catch (error) {
    showToast(error.message);
  } finally {
    state.busy = false;
  }
}

async function selectLead(id) {
  if (state.leadModal && state.detail?.id !== id && state.profileDirty) {
    const choice = await confirmDirtyProfile();
    if (choice === "keep") return;
    if (choice === "save") {
      const saved = await saveProfile(false);
      if (!saved) return;
    }
    state.profileDirty = false;
    state.profileDraft = null;
  }
  state.detail = await api(`/api/leads/${id}`);
  state.leadModal = true;
  state.noteEdit = null;
  state.noteTags = [];
  state.noteDraft = "";
  await loadRecordNotes(id);
  if (state.leadsTab === "chat") {
    try { await ensureCoachSession(state.detail); } catch (error) { showToast(error.message); }
  }
  render();
}

function paintTimer() {
  document.querySelectorAll("[data-timer]").forEach((node) => {
    node.textContent = formatDuration(timerSeconds(node.dataset.timer));
  });
  const clock = document.getElementById("session-clock");
  if (clock) clock.textContent = formatClock(Date.now() - state.session.started);
}

document.body.addEventListener("click", async (event) => {
  const trigger = event.target.closest("[data-action]");
  if (!trigger) return;
  const action = trigger.dataset.action;
  if (action === "check-lead" || action === "select-page") return;
  if (action === "dial" || action === "dial-row") {
    const lead = action === "dial" ? state.queue.lead : state.leads.find((item) => item.id === trigger.dataset.id) || state.detail;
    onDial(lead);
    return;
  }
  if (action === "timer-start") {
    startTimer(trigger.dataset.id);
    paintTimer();
    return;
  }
  if (action === "timer-stop") {
    stopTimer(trigger.dataset.id);
    paintTimer();
    return;
  }
  if (action === "reset-attempts") {
    if (!window.confirm("Reset the attempt count to 0? Call history stays.")) return;
    try {
      const updated = await api(`/api/leads/${trigger.dataset.id}/reset-attempts`, { method: "POST" });
      if (state.queue.lead?.id === updated.id) state.queue.lead.attempts = updated.attempts;
      if (state.detail?.id === updated.id) state.detail = { ...state.detail, ...updated };
      showToast("Attempts reset");
      await refreshCore();
      render();
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (action === "archive-lead") {
    const archived = trigger.dataset.archived !== "1";
    if (archived && !window.confirm("Archive this lead? They leave the queue and stay in the directory.")) return;
    try {
      await api(`/api/leads/${trigger.dataset.id}/archive`, { method: "POST", body: JSON.stringify({ archived }) });
      showToast(archived ? "Lead archived" : "Lead restored");
      if (state.detail?.id === trigger.dataset.id && archived && state.statusFilter !== "archived") state.detail = null;
      await refreshCore();
      if (state.view === "dial") await showView("dial");
      else await showView("leads");
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (action === "nav") {
    if (state.profileDirty) {
      const choice = await confirmDirtyProfile();
      if (choice === "keep") return;
      if (choice === "save") {
        const saved = await saveProfile(false);
        if (!saved) return;
      }
      state.profileDirty = false;
      state.profileDraft = null;
    }
    state.leadModal = false;
    restoreParkedCoach();
    await showView(trigger.dataset.view);
  }
  else if (action === "open-lead") leadForm(null);
  else if (action === "edit-lead") leadForm(state.detail?.id === trigger.dataset.id ? state.detail : state.leads.find((lead) => lead.id === trigger.dataset.id));
  else if (action === "open-campaign") campaignForm();
  else if (action === "open-script") scriptForm();
  else if (action === "import") importForm();
  else if (action === "close-modal") closeModal();
  else if (action === "disposition") onDisposition(trigger.dataset.outcome, trigger.dataset.lead);
  else if (action === "record-tab") await switchRecordTab(trigger.dataset.scope, trigger.dataset.tab);
  else if (action === "close-lead") await closeLeadModal();
  else if (action === "note-tag") {
    const tag = trigger.dataset.tag;
    state.noteTags = state.noteTags.includes(tag) ? state.noteTags.filter((item) => item !== tag) : [...state.noteTags, tag];
    trigger.className = `rounded-full border px-2 py-1 text-[11px] ${state.noteTags.includes(tag) ? "border-mint text-mint" : "border-line text-slate-300"}`;
  } else if (action === "note-edit") {
    state.noteEdit = trigger.dataset.id;
    render();
  } else if (action === "note-edit-cancel") {
    state.noteEdit = null;
    render();
  } else if (action === "note-delete") {
    const choice = await askConfirm("Delete this note?", [
      { id: "save", label: "Delete" },
      { id: "keep", label: "Keep" },
    ]);
    if (choice !== "save") return;
    const removed = await api(`/api/lead-notes/${trigger.dataset.id}`, { method: "DELETE" });
    const leadId = removed?.leadId || recordLead()?.id;
    if (leadId) await loadRecordNotes(leadId);
    state.noteEdit = null;
    render();
  }
  else if (action === "objection") {
    state.objectionLabel = state.objectionLabel === trigger.dataset.label ? null : trigger.dataset.label;
    render();
  } else if (action === "tag") {
    const note = document.getElementById("notes");
    if (!note) return;
    const next = `${note.value}${note.value ? " " : ""}#${trigger.dataset.tag}`;
    note.value = next;
    onNotesInput(next);
  } else if (action === "pause") {
    state.paused = !state.paused;
    render();
  } else if (action === "skip") {
    if (!state.queue.lead) return;
    stopCallCapture();
    await api(`/api/leads/${state.queue.lead.id}/skip`, { method: "POST" });
    await loadQueue();
    render();
  } else if (action === "copy-followup") {
    const campaign = campaignById(state.queue.lead?.campaignId);
    const step = campaign?.cadence?.steps?.find((item) => item.type === "followup");
    const text = `${step?.subject || ""}\n${fillTokens(step?.body || "", state.queue.lead)}`.trim();
    await navigator.clipboard.writeText(text);
    showToast("Follow-up copied");
  } else if (action === "status") {
    state.statusFilter = trigger.dataset.status;
    await loadLeads();
    render();
  } else if (action === "select-lead") {
    if (event.target.closest("a, input, button")) return;
    await selectLead(trigger.dataset.id);
  } else if (action === "enqueue-selected") {
    const result = await api("/api/leads/enqueue", { method: "POST", body: JSON.stringify({ ids: [...state.selected] }) });
    showToast(`Queued ${result.queued}`);
    state.selected.clear();
    await refreshCore();
    await showView("leads");
  } else if (action === "enqueue-filtered") {
    const ids = state.leads.filter((lead) => lead.status !== "dnc").map((lead) => lead.id);
    const result = await api("/api/leads/enqueue", { method: "POST", body: JSON.stringify({ ids }) });
    showToast(`Queued ${result.queued}`);
    await refreshCore();
    await loadLeads();
    render();
  } else if (action === "export") {
    const params = new URLSearchParams();
    if (state.search.trim()) params.set("search", state.search.trim());
    if (state.statusFilter === "archived") params.set("archived", "1");
    else if (state.statusFilter) params.set("status", state.statusFilter);
    if (state.campaignFilter) params.set("campaignId", state.campaignFilter);
    window.location = `/api/leads/export${params.toString() ? `?${params}` : ""}`;
  } else if (action === "requeue") {
    await api(`/api/leads/${trigger.dataset.id}/requeue`, { method: "POST" });
    showToast("Re-queued");
    await refreshCore();
    await showView(state.view);
  } else if (action === "delete-lead") {
    if (!window.confirm(`Delete ${trigger.dataset.name}?`)) return;
    await api(`/api/leads/${trigger.dataset.id}`, { method: "DELETE" });
    state.detail = null;
    await refreshCore();
    await showView("leads");
  } else if (action === "pick-campaign") {
    state.builderId = trigger.dataset.id;
    state.stepIndex = 0;
    render();
  } else if (action === "pick-step") {
    const campaign = campaignById(state.builderId);
    if (campaign) Object.assign(campaign, { cadence: readCadenceFromDom(campaign).cadence });
    state.stepIndex = Number(trigger.dataset.index);
    render();
  } else if (action === "add-step") {
    const campaign = campaignById(state.builderId);
    if (!campaign) return;
    const { cadence } = readCadenceFromDom(campaign);
    const type = trigger.dataset.type;
    cadence.steps.push(type === "wait"
      ? { id: crypto.randomUUID(), type, hours: 4 }
      : type === "followup"
        ? { id: crypto.randomUUID(), type, subject: "Following up", body: "Hi {{first_name}} —" }
        : { id: crypto.randomUUID(), type, label: "Power dial", day: 1, time: cadence.windowStart });
    campaign.cadence = cadence;
    state.stepIndex = cadence.steps.length - 1;
    render();
  } else if (action === "save-cadence") {
    const campaign = campaignById(state.builderId);
    const { cadence, scriptId, status } = readCadenceFromDom(campaign);
    const saved = await api(`/api/campaigns/${campaign.id}`, { method: "PATCH", body: JSON.stringify({ cadence, scriptId, status }) });
    showToast("Cadence saved");
    await refreshCore();
    state.builderId = saved.id;
    render();
  } else if (action === "delete-campaign") {
    if (!window.confirm(`Delete ${trigger.dataset.name}? Leads stay.`)) return;
    await api(`/api/campaigns/${trigger.dataset.id}`, { method: "DELETE" });
    state.builderId = null;
    await refreshCore();
    await showView("campaigns");
  } else if (action === "pick-script") {
    state.scriptId = trigger.dataset.id;
    render();
  } else if (action === "add-section" || action === "remove-section" || action === "add-objection" || action === "remove-objection") {
    const script = state.scripts.find((item) => item.id === state.scriptId);
    const draft = readScriptFromDom();
    if (action === "add-section") draft.sections.push({ label: "New section", text: "" });
    if (action === "remove-section") draft.sections.splice(Number(trigger.dataset.index), 1);
    if (action === "add-objection") draft.objections.push({ label: "", response: "" });
    if (action === "remove-objection") draft.objections.splice(Number(trigger.dataset.index), 1);
    script.sections = draft.sections;
    script.objections = draft.objections;
    script.name = draft.name;
    render();
  } else if (action === "save-script") {
    const payload = readScriptFromDom();
    const saved = await api(`/api/scripts/${state.scriptId}`, { method: "PATCH", body: JSON.stringify(payload) });
    showToast("Script saved");
    await refreshCore();
    state.scriptId = saved.id;
    render();
  } else if (action === "delete-script") {
    if (!window.confirm(`Delete ${trigger.dataset.name}?`)) return;
    await api(`/api/scripts/${trigger.dataset.id}`, { method: "DELETE" });
    state.scriptId = null;
    await refreshCore();
    await showView("scripts");
  } else if (action === "save-settings") {
    state.settings = await api("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({
        gvLine: document.getElementById("gv-line").value,
        clipboardFallback: document.getElementById("clipboard-fallback").checked,
      }),
    });
    showToast("Saved");
    render();
  } else if (action === "save-webhook") {
    try {
      const events = [...document.querySelectorAll("[data-webhook-event]:checked")].map((node) => node.value);
      await api("/api/webhooks", {
        method: "POST",
        body: JSON.stringify({
          name: document.getElementById("webhook-name").value,
          url: document.getElementById("webhook-url").value,
          secret: document.getElementById("webhook-secret").value,
          events,
        }),
      });
      state.webhooks = await api("/api/webhooks");
      showToast("Webhook saved");
      render();
    } catch (error) {
      showToast(error.message);
    }
  } else if (action === "delete-webhook") {
    await api(`/api/webhooks/${trigger.dataset.id}`, { method: "DELETE" });
    state.webhooks = state.webhooks.filter((hook) => hook.id !== trigger.dataset.id);
    showToast("Webhook deleted");
    render();
  } else if (action === "test-webhook") {
    try {
      const result = await api(`/api/webhooks/${trigger.dataset.id}/test`, { method: "POST" });
      state.webhooks = await api("/api/webhooks");
      showToast(result.status === "ok" ? `Webhook answered ${result.responseCode}` : (result.error || "Webhook failed"));
      render();
    } catch (error) {
      showToast(error.message);
    }
  } else if (action === "dial-test") {
    const digits = document.getElementById("dial-test").value.replace(/\D/g, "");
    const phone = digits.length === 10 ? `1${digits}` : digits;
    const url = voiceUrl(phone);
    document.getElementById("dial-test-url").textContent = url;
    window.open(url, "_blank", "noopener");
  } else if (action === "inbox-folder") {
    state.inboxFolder = trigger.dataset.folder;
    state.composing = false;
    await loadInbox();
    render();
  } else if (action === "open-thread") {
    state.composing = false;
    state.inboxId = trigger.dataset.id;
    state.inboxDetail = await api(`/api/inbox/threads/${state.inboxId}`);
    if (state.stats?.inbox) state.stats.inbox.unread = Math.max(0, (state.inboxSummary?.unread || 0));
    await loadInbox();
    render();
  } else if (action === "compose-mail") {
    state.composing = true;
    render();
  } else if (action === "close-compose") {
    state.composing = false;
    render();
  } else if (action === "save-mail") {
    try {
    const leadId = document.getElementById("mail-lead").value;
    const created = await api("/api/inbox/threads", {
      method: "POST",
      body: JSON.stringify({
        leadId: leadId || null,
        to: document.getElementById("mail-to").value,
        subject: document.getElementById("mail-subject").value,
        body: document.getElementById("mail-body").value,
        send: trigger.dataset.send === "true",
        pauseTriggers: document.getElementById("mail-pause").checked,
      }),
    });
    state.composing = false;
    state.inboxId = created.thread.id;
    state.inboxDetail = created;
    showToast(created.messages.at(-1)?.status === "local" ? "Saved in the local outbox" : created.messages.at(-1)?.status === "sent" ? "Sent" : "Draft saved");
    await refreshCore();
    await loadInbox();
    render();
    } catch (error) {
      showToast(error.message);
    }
  } else if (action === "reply-mail") {
    try {
    const saved = await api(`/api/inbox/threads/${state.inboxId}/reply`, {
      method: "POST",
      body: JSON.stringify({
        body: document.getElementById("reply-body").value,
        send: trigger.dataset.send === "true",
        pauseTriggers: document.getElementById("reply-pause").checked,
      }),
    });
    state.inboxDetail = saved;
    showToast(saved.messages.at(-1)?.status === "draft" ? "Draft saved" : saved.messages.at(-1)?.status === "sent" ? "Sent" : "Saved in the local outbox");
    await loadInbox();
    render();
    } catch (error) {
      showToast(error.message);
    }
  } else if (action === "log-reply") {
    try {
    const saved = await api(`/api/inbox/threads/${state.inboxId}/inbound`, {
      method: "POST",
      body: JSON.stringify({ body: document.getElementById("inbound-body").value }),
    });
    state.inboxDetail = saved;
    showToast("Reply logged");
    await refreshCore();
    await loadInbox();
    render();
    } catch (error) {
      showToast(error.message);
    }
  } else if (action === "toggle-triggers") {
    const paused = !state.inboxDetail.thread.triggersPaused;
    state.inboxDetail = await api(`/api/inbox/threads/${state.inboxId}`, { method: "PATCH", body: JSON.stringify({ triggersPaused: paused }) });
    await loadInbox();
    render();
  } else if (action === "delete-thread") {
    if (!window.confirm("Delete this thread?")) return;
    await api(`/api/inbox/threads/${state.inboxId}`, { method: "DELETE" });
    state.inboxId = null;
    state.inboxDetail = null;
    await refreshCore();
    await loadInbox();
    render();
  } else if (action === "draft-idle") {
    const lead = state.leads.find((item) => item.id === trigger.dataset.id);
    const created = await api("/api/inbox/threads", {
      method: "POST",
      body: JSON.stringify({
        leadId: lead.id,
        to: lead.email,
        subject: `Checking in, ${firstName(lead.name)}`,
        body: `Hi ${firstName(lead.name)}, it has been a few days since we last spoke about ${lead.company || "your team"}. Worth another look this week?`,
        triggerKey: "idle",
      }),
    });
    state.inboxFolder = "idle";
    state.inboxId = created.thread.id;
    state.inboxDetail = created;
    state.composing = false;
    await loadInbox();
    render();
  } else if (action === "book-demo") {
    const lead = state.inboxDetail?.lead;
    const created = await api("/api/inbox/threads", {
      method: "POST",
      body: JSON.stringify({
        leadId: lead?.id || null,
        to: lead?.email || "",
        subject: `15 minutes${lead ? ` with ${firstName(lead.name)}` : ""}`,
        body: `Hi ${firstName(lead?.name)}, does a 15-minute look later this week work?`,
        triggerKey: "demo",
      }),
    });
    state.inboxId = created.thread.id;
    state.inboxDetail = created;
    await loadInbox();
    render();
  } else if (action === "coach-pause") {
    if (!state.coachSession) return;
    state.coachSession = await api(`/api/coach/sessions/${state.coachSession.id}`, {
      method: "PATCH",
      body: JSON.stringify({ paused: !state.coachSession.paused }),
    });
    state.coachStatus = state.coachSession.paused ? "Coach paused. The transcript keeps going." : "Coach resumed.";
    paintCoach();
  } else if (action === "coach-stop") {
    stopCallCapture();
    state.coachStatus = "Listening stopped. The transcript is still here.";
    paintCoach();
  } else if (action === "coach-reset") {
    if (!state.coachSession || state.coachBusy) return;
    const choice = await askConfirm("Clear this chat? The thread and its branches are removed.", [
      { id: "save", label: "Reset chat" },
      { id: "keep", label: "Keep chat" },
    ]);
    if (choice !== "save") return;
    const familyIds = new Set((state.coachSession.branches || []).map((branch) => branch.id).concat(state.coachSession.id));
    if (captureHandle && familyIds.has(state.coachLiveId)) stopCallCapture();
    try {
      const fresh = await api(`/api/coach/sessions/${state.coachSession.id}/reset`, { method: "POST" });
      state.coachSession = fresh;
      state.coachPin = false;
      state.coachLiveId = null;
      state.coachEdit = null;
      state.wrongFor = null;
      state.coachInfo = null;
      state.coachStreaming = false;
      state.coachStatus = "Chat cleared.";
      if (parkedCoach && familyIds.has(parkedCoach.session?.id)) parkedCoach = null;
      showToast("Chat cleared");
      render();
    } catch (error) {
      showToast(error.message);
    }
  } else if (action === "coach-hide") {
    state.coachPin = false;
    state.coachSession = null;
    state.wrongFor = null;
    state.coachStatus = "";
    render();
  } else if (action === "coach-copy") {
    const message = state.coachSession?.messages?.find((item) => item.id === trigger.dataset.id);
    if (!message) return;
    try {
      await navigator.clipboard.writeText(message.body);
      showToast("Copied");
    } catch (error) {
      showToast(error.message);
    }
  } else if (action === "coach-edit") {
    state.coachEdit = state.coachEdit === trigger.dataset.id ? null : trigger.dataset.id;
    state.wrongFor = null;
    paintCoach();
  } else if (action === "coach-edit-cancel") {
    state.coachEdit = null;
    paintCoach();
  } else if (action === "coach-info") {
    state.coachInfo = state.coachInfo === trigger.dataset.id ? null : trigger.dataset.id;
    paintCoach();
  } else if (action === "coach-up") {
    try {
      state.coachSession = await api(`/api/coach/messages/${trigger.dataset.id}/feedback`, {
        method: "POST",
        body: JSON.stringify({ vote: "up" }),
      });
      const saved = state.coachSession.messages.find((item) => item.id === trigger.dataset.id);
      showToast(saved?.rating === "up" ? "Saved to coach memory" : "Mark cleared");
      paintCoach();
    } catch (error) {
      showToast(error.message);
    }
  } else if (action === "coach-down") {
    state.wrongFor = state.wrongFor === trigger.dataset.id ? null : trigger.dataset.id;
    paintCoach();
  } else if (action === "coach-continue") {
    try {
      await streamCoachMessage(`/api/coach/messages/${trigger.dataset.id}/continue`, {});
    } catch (error) {
      showToast(error.message);
    }
  } else if (action === "coach-regen") {
    try {
      await streamCoachMessage(`/api/coach/messages/${trigger.dataset.id}/regenerate`, {});
    } catch (error) {
      showToast(error.message);
    }
  } else if (action === "coach-branch") {
    try {
      state.coachSession = await api(`/api/coach/sessions/${state.coachSession.id}/branch`, {
        method: "POST",
        body: JSON.stringify({ messageId: trigger.dataset.id }),
      });
      state.coachPin = true;
      state.coachStatus = "Side thread. The live call stays on the original.";
      paintCoach();
    } catch (error) {
      showToast(error.message);
    }
  } else if (action === "coach-sibling") {
    const message = state.coachSession?.messages?.find((item) => item.id === trigger.dataset.id);
    if (!message?.siblingIds) return;
    const next = message.siblingIds[message.siblingIndex - 1 + Number(trigger.dataset.dir)];
    if (!next) return;
    try {
      state.coachSession = await api(`/api/coach/messages/${next}/select`, { method: "POST" });
      paintCoach();
    } catch (error) {
      showToast(error.message);
    }
  } else if (action === "coach-strip" || action === "coach-run") {
    try {
      await runCoachAction(coachActionById(trigger.dataset.actionId), trigger.dataset.id);
    } catch (error) {
      showToast(error.message);
    }
  } else if (action === "coach-wrong") {
    state.wrongFor = state.wrongFor === trigger.dataset.id ? null : trigger.dataset.id;
    paintCoach();
  } else if (action === "open-coach-call") {
    try {
      state.coachSession = await api(`/api/coach/calls/${trigger.dataset.id}`);
      state.coachPin = true;
      state.coachStatus = "Saved call. Replay the audio from each line.";
      if (state.view !== "dial") await showView("dial");
      else render();
    } catch (error) {
      showToast(error.message);
    }
  } else if (action === "save-models") {
    const payload = {
      llmProvider: document.getElementById("llm-provider").value,
      llmBaseUrl: document.getElementById("llm-base").value,
      llmLiveModel: document.getElementById("llm-live-model").value,
      llmReviewModel: document.getElementById("llm-review-model").value,
      sttMode: document.getElementById("stt-mode").value,
      whisperModel: document.getElementById("whisper-model").value,
      sttBaseUrl: document.getElementById("stt-base").value,
      sttModel: document.getElementById("stt-model").value,
      embedProvider: document.getElementById("embed-provider").value,
      embedBaseUrl: document.getElementById("embed-base").value,
      embedModel: document.getElementById("embed-model").value,
    };
    const llmKey = document.getElementById("llm-key").value;
    const sttKey = document.getElementById("stt-key").value;
    const embedKey = document.getElementById("embed-key").value;
    if (llmKey) payload.llmApiKey = llmKey;
    if (sttKey) payload.sttApiKey = sttKey;
    if (embedKey) payload.embedApiKey = embedKey;
    state.settings = await api("/api/settings", { method: "PATCH", body: JSON.stringify(payload) });
    showToast("Models saved");
    render();
  } else if (action === "new-playbook") {
    state.playbookId = null;
    render();
  } else if (action === "select-playbook") {
    state.playbookId = trigger.dataset.id;
    render();
  } else if (action === "delete-playbook") {
    await api(`/api/playbooks/${trigger.dataset.id}`, { method: "DELETE" });
    state.playbooks = state.playbooks.filter((item) => item.id !== trigger.dataset.id);
    state.playbookId = state.playbooks[0]?.id || null;
    showToast("Playbook deleted");
    render();
  } else if (action === "delete-coach-action") {
    await api(`/api/coach/actions/${trigger.dataset.id}`, { method: "DELETE" });
    state.coachActions = await api("/api/coach/actions");
    showToast("Action deleted");
    render();
  } else if (action === "toggle-coach-action") {
    await api(`/api/coach/actions/${trigger.dataset.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: trigger.dataset.enabled === "1" }),
    });
    state.coachActions = await api("/api/coach/actions");
    render();
  } else if (action === "save-mailbox") {
    const form = document.getElementById("mail-settings");
    const payload = Object.fromEntries(new FormData(form));
    if (!payload.smtpPass) delete payload.smtpPass;
    state.settings = await api("/api/settings", { method: "PATCH", body: JSON.stringify(payload) });
    showToast(state.settings.smtpConfigured ? "SMTP saved" : "Mailbox saved");
    await loadInbox();
    render();
  } else if (action === "send-api") {
    const path = document.getElementById("api-path").value;
    state.apiPath = path;
    try {
      const data = await api(path);
      state.apiResult = JSON.stringify(data, null, 2);
    } catch (error) {
      state.apiResult = error.message;
    }
    render();
  }
});

document.body.addEventListener("change", async (event) => {
  if (event.target.closest("#profile-form")) rememberProfileForm();
  if (event.target.dataset.action === "check-lead") {
    const id = event.target.dataset.id;
    if (event.target.checked) state.selected.add(id);
    else state.selected.delete(id);
    const count = document.querySelector("[data-action=enqueue-selected]");
    if (count) count.textContent = `Enqueue selected (${state.selected.size})`;
    return;
  }
  if (event.target.dataset.action === "select-page") {
    state.leads.forEach((lead) => {
      if (event.target.checked) state.selected.add(lead.id);
      else state.selected.delete(lead.id);
    });
    render();
    return;
  }
  if (event.target.id === "mail-lead") {
    const lead = state.leads.find((item) => item.id === event.target.value);
    const to = document.getElementById("mail-to");
    if (lead && to && !to.value) to.value = lead.email || "";
  }
  if (event.target.id === "mail-snippet") {
    const snippet = state.inboxSnippets.find((item) => item.id === event.target.value);
    if (!snippet) return;
    const subject = document.getElementById("mail-subject");
    const body = document.getElementById("mail-body");
    if (snippet.subject && subject) subject.value = snippet.subject;
    if (body) body.value = snippet.body;
  }
  if (event.target.id === "campaign-status" || event.target.id === "campaign-script") {
    const campaign = campaignById(state.builderId) || state.campaigns[0];
    if (!campaign) return;
    const body = event.target.id === "campaign-status"
      ? { status: event.target.value }
      : { scriptId: event.target.value || null };
    try {
      const saved = await api(`/api/campaigns/${campaign.id}`, { method: "PATCH", body: JSON.stringify(body) });
      const index = state.campaigns.findIndex((item) => item.id === saved.id);
      if (index >= 0) state.campaigns[index] = saved;
      showToast("Campaign updated");
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (event.target.id === "campaign-filter" || event.target.id === "dial-campaign") {
    state.campaignFilter = event.target.value;
    if (event.target.id === "dial-campaign") await loadQueue();
    else await loadLeads();
    render();
  }
});

document.body.addEventListener("input", (event) => {
  if (event.target.closest("#profile-form")) rememberProfileForm();
  if (event.target.closest("#note-form textarea")) state.noteDraft = event.target.value;
  if (event.target.id === "inbox-search") {
    state.inboxSearch = event.target.value;
    clearTimeout(searchTimer);
    const caret = event.target.selectionStart;
    searchTimer = setTimeout(async () => {
      await loadInbox();
      render();
      const search = document.getElementById("inbox-search");
      if (search) {
        search.focus();
        search.setSelectionRange(caret, caret);
      }
    }, 200);
  }
  if (event.target.id === "search") {
    state.search = event.target.value;
    clearTimeout(searchTimer);
    const caret = event.target.selectionStart;
    searchTimer = setTimeout(async () => {
      await loadLeads();
      render();
      const search = document.getElementById("search");
      if (search) {
        search.focus();
        search.setSelectionRange(caret, caret);
      }
    }, 200);
  }
});

document.body.addEventListener("submit", async (event) => {
  if (event.target.id === "profile-form") {
    event.preventDefault();
    try {
      await saveProfile(true);
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (event.target.id === "note-form") {
    event.preventDefault();
    const form = event.target;
    const body = new FormData(form).get("body");
    const text = String(body || "").trim();
    if (!text) return;
    try {
      await api(`/api/leads/${form.dataset.lead}/notes`, {
        method: "POST",
        body: JSON.stringify({ body: text, tags: state.noteTags }),
      });
      state.noteDraft = "";
      state.noteTags = [];
      await loadRecordNotes(form.dataset.lead);
      render();
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (event.target.dataset.noteEdit) {
    event.preventDefault();
    const text = String(new FormData(event.target).get("body") || "").trim();
    if (!text) return;
    try {
      const saved = await api(`/api/lead-notes/${event.target.dataset.noteEdit}`, {
        method: "PATCH",
        body: JSON.stringify({ body: text }),
      });
      state.noteEdit = null;
      await loadRecordNotes(saved.leadId);
      render();
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (event.target.id === "coach-form") {
    event.preventDefault();
    const input = document.getElementById("coach-input");
    const text = input?.value.trim();
    const lead = recordLead();
    if (!text || state.coachBusy || (!lead && !state.coachSession)) return;
    input.value = "";
    state.coachBusy = true;
    showOwnCoachNote(text);
    coachLiveText = "";
    state.coachStreaming = true;
    state.coachStatus = "Writing…";
    const status = document.getElementById("coach-status");
    if (status) status.textContent = "Writing…";
    showCoachDraft();
    let posted = false;
    try {
      const session = await ensureCoachSession(lead);
      posted = true;
      const streamed = await consumeCoachStream(`/api/coach/sessions/${session.id}/notes`, { text }, coachStreamHandlers());
      const updated = streamed.session;
      state.coachSession = updated;
      if (streamed.personaUpdated) {
        state.settings = await api("/api/settings");
        showToast("Coach instructions updated");
      }
      if (streamed.notepadUpdated && updated?.leadId) {
        await loadRecordNotes(updated.leadId);
        const savedLead = await api(`/api/leads/${updated.leadId}`);
        if (state.queue?.lead?.id === savedLead.id) state.queue.lead = savedLead;
        if (state.detail?.id === savedLead.id) state.detail = savedLead;
        showToast("Note added");
        if (recordTab(state.view === "leads" ? "leads" : "dial") === "notes") render();
      }
      state.coachStatus = coachReadyLine(state.queue?.lead, updated);
    } catch (error) {
      if (!posted && input) input.value = text;
      showToast(error.message);
      if (posted && state.coachSession?.id) {
        try { state.coachSession = await api(`/api/coach/sessions/${state.coachSession.id}`); } catch { /* keep the draft */ }
      }
    } finally {
      state.coachBusy = false;
      state.coachStreaming = false;
      coachLiveText = "";
      paintCoach();
    }
    return;
  }
  if (event.target.dataset.editForm) {
    event.preventDefault();
    const id = event.target.dataset.editForm;
    const body = String(new FormData(event.target).get("body") || "").trim();
    const message = state.coachSession?.messages?.find((item) => item.id === id);
    if (!body || !message) return;
    try {
      if (message.kind === "note") await streamCoachMessage(`/api/coach/messages/${id}/edit`, { body });
      else {
        state.coachEdit = null;
        state.coachSession = await api(`/api/coach/messages/${id}/edit`, { method: "POST", body: JSON.stringify({ body }) });
        paintCoach();
      }
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (event.target.dataset.wrongForm) {
    event.preventDefault();
    const reason = String(new FormData(event.target).get("reason") || "").trim();
    if (!reason) return;
    try {
      state.coachSession = await api(`/api/coach/messages/${event.target.dataset.wrongForm}/feedback`, {
        method: "POST",
        body: JSON.stringify({ vote: "down", reason }),
      });
      state.wrongFor = null;
      paintCoach();
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (event.target.id === "persona-form") {
    event.preventDefault();
    try {
      state.settings = await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify(Object.fromEntries(new FormData(event.target))),
      });
      showToast("Persona saved");
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (event.target.id === "coach-action-form") {
    event.preventDefault();
    const form = new FormData(event.target);
    const effect = String(form.get("effect") || "steer");
    const text = String(form.get("text") || "").trim();
    const payload = effect === "disposition"
      ? { outcome: String(form.get("outcome") || "") }
      : effect === "prompt"
        ? { prompt: text }
        : { text };
    try {
      await api("/api/coach/actions", {
        method: "POST",
        body: JSON.stringify({
          label: form.get("label"),
          icon: form.get("icon"),
          placement: form.get("placement"),
          effect,
          shortcut: form.get("shortcut"),
          kinds: form.getAll("kinds"),
          payload,
        }),
      });
      state.coachActions = await api("/api/coach/actions");
      showToast("Action added");
      render();
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (event.target.id === "playbook-form") {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.target));
    try {
      const saved = state.playbookId
        ? await api(`/api/playbooks/${state.playbookId}`, { method: "PATCH", body: JSON.stringify(payload) })
        : await api("/api/playbooks", { method: "POST", body: JSON.stringify(payload) });
      state.playbookId = saved.id;
      state.playbooks = await api("/api/playbooks");
      showToast("Playbook saved");
      render();
    } catch (error) {
      showToast(error.message);
    }
  }
});

document.body.addEventListener("change", async (event) => {
  if (!event.target.dataset.speakerFor && event.target.id !== "coach-branch") return;
  if (event.target.id === "coach-branch") {
    try {
      state.coachSession = await api(`/api/coach/sessions/${event.target.value}`);
      state.coachPin = state.coachSession.rootId !== state.coachSession.id;
      state.coachStatus = state.coachPin ? "Side thread. The live call stays on the original." : coachReadyLine(state.queue?.lead, state.coachSession);
      paintCoach();
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  try {
    state.coachSession = await api(`/api/coach/messages/${event.target.dataset.speakerFor}`, {
      method: "PATCH",
      body: JSON.stringify({ speaker: event.target.value }),
    });
    paintCoach();
  } catch (error) {
    showToast(error.message);
  }
});

document.getElementById("modal").addEventListener("click", (event) => {
  if (event.target.id === "modal") closeModal();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModal();
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
  if (state.view !== "dial" || typing || document.getElementById("modal")?.classList.contains("flex")) return;
  if ((event.key === " " || event.key === "Enter") && !state.paused) {
    event.preventDefault();
    const link = document.getElementById("dial-link");
    if (link) link.click();
  }
  const shortcut = event.code === "NumpadAdd" ? "NumpadAdd" : event.code === "NumpadSubtract" ? "NumpadSubtract" : event.code === "NumpadMultiply" ? "NumpadMultiply" : (/^[0-9]$/.test(event.key) ? event.key : "");
  if (shortcut) {
    const action = (state.coachActions || []).find((item) => item.enabled && item.shortcut === shortcut);
    if (action?.effect === "disposition") onDisposition(action.payload.outcome);
    else if (action?.effect === "steer") steerCoach(action).catch((error) => showToast(error.message));
    else if (/^[1-5]$/.test(shortcut)) onDisposition(OUTCOMES[Number(shortcut) - 1].id);
  } else if (event.key.toLowerCase() === "n") {
    document.querySelector("[data-action=skip]")?.click();
  }
});

setInterval(paintTimer, 1000);
setInterval(async () => {
  if (state.coachSession?.reviewStatus !== "pending") return;
  try {
    const latest = await api(`/api/coach/sessions/${state.coachSession.id}`);
    const changed = latest.reviewStatus !== state.coachSession.reviewStatus || latest.messages.length !== state.coachSession.messages.length;
    if (latest.reviewStatus === "done") state.coachStatus = "Review saved on this call.";
    if (latest.reviewStatus === "failed") state.coachStatus = "The review did not finish.";
    state.coachSession = latest;
    if (changed && state.view === "dial") paintCoach();
  } catch {
    /* keep the last thread on screen */
  }
}, 2000);

refreshCore().then(() => showView("dial")).catch((error) => {
  document.getElementById("app").innerHTML = `<p class="p-8 text-rose-300">${esc(error.message)}</p>`;
});
