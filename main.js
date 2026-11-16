// Agent Tren — Electron main process: hook server + always-on-top widget
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, Notification, dialog, globalShortcut, shell } = require("electron");
const claude = require("./claude-settings");
const http = require("http");
const path = require("path");
const { exec } = require("child_process");
const fs = require("fs");
const os = require("os");

const PORT = 4545;
const WIDTH = 340;
const GAP = 16; // visible space between the widget and the screen edges
const INSET = 6; // transparent margin around the panel inside the window (see #panel margin)
const SNAP = 90; // drop it this close to a corner and it locks in
const STALE_MS = 6 * 60 * 60 * 1000; // hide sessions with no activity for 6h

const base = (p) => path.win32.basename(p || "");
const sessions = new Map(); // id -> session
const dismissed = new Map(); // id -> time the card was removed
let dismissedFile;
function loadDismissed() {
  dismissedFile = path.join(app.getPath("userData"), "dismissed.json");
  try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(dismissedFile, "utf8")))) dismissed.set(k, v); } catch {}
}
function saveDismissed() {
  const cutoff = Date.now() - 2 * STALE_MS;
  for (const [k, v] of dismissed) if (v < cutoff) dismissed.delete(k);
  try { fs.writeFileSync(dismissedFile, JSON.stringify(Object.fromEntries(dismissed))); } catch {}
}
const pending = new Map(); // requestId -> { res, sessionId, kind, event }
let win;
let reqCounter = 0;

// ---------- session state ----------
function getSession(e) {
  let s = sessions.get(e.session_id);
  if (!s) {
    s = {
      id: e.session_id,
      cwd: e.cwd,
      project: base(e.cwd) || "session",
      task: "",
      status: "idle",
      activity: "Starting",
      todos: [],
      terminal: null,
      pending: null,
      flash: null,
      createdAt: Date.now(),
    };
    sessions.set(e.session_id, s);
  }
  s.updatedAt = Date.now();
  if (e.cwd) s.cwd = e.cwd;
  return s;
}

function taskLabel(prompt) {
  const words = String(prompt || "").replace(/\s+/g, " ").trim().split(" ").slice(0, 4).join(" ");
  return words.length > 28 ? words.slice(0, 28) + "…" : words;
}

function describeTool(name, input = {}) {
  const short = (v, n = 40) => {
    const t = String(v || "").replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n) + "…" : t;
  };
  switch (name) {
    case "Bash": case "PowerShell": return input.description || `Running ${short(input.command)}`;
    case "Read": return `Reading ${base(input.file_path)}`;
    case "Write": return `Writing ${base(input.file_path)}`;
    case "Edit": case "MultiEdit": return `Editing ${base(input.file_path)}`;
    case "Grep": case "Glob": return `Searching ${short(input.pattern, 30)}`;
    case "WebSearch": return `Searching the web`;
    case "WebFetch": return `Reading a web page`;
    case "TodoWrite": case "TaskCreate": case "TaskUpdate": return "Planning";
    case "Agent": case "Task": return input.description || "Running a subagent";
    case "AskUserQuestion": return "asks a question";
    default: return name ? name.replace(/^mcp__[^_]+__/, "") : "";
  }
}

// ---------- subagents: each gets its own card ----------
const AGENT_LINGER_MS = 8000; // finished agent cards stay this long

function findAgent(s, id) { return s.agents.find((a) => a.id === String(id)); }

function newAgent(s, id, type) {
  const t = type || "agent";
  // name it after the matching Agent tool call from the parent
  const li = (s.launches || []).findIndex((l) => l.type === t) >= 0
    ? s.launches.findIndex((l) => l.type === t)
    : (s.launches || []).length ? 0 : -1;
  const launch = li >= 0 ? s.launches.splice(li, 1)[0] : null;
  const a = {
    id: String(id),
    parent: s.id,
    type: t,
    desc: launch?.desc || "",
    prompt: launch?.prompt || "",
    background: launch?.background || false,
    status: "working",
    activity: "Starting",
    todos: [],
    lastReply: "",
    startedAt: Date.now(),
  };
  s.agents.push(a);
  return a;
}

function getAgent(s, id, type) { return findAgent(s, id) || newAgent(s, id, type); }

function finishAgent(s, a, reply) {
  a.status = "done";
  a.activity = "Done";
  if (reply) a.lastReply = reply;
  a.doneAt = Date.now();
  setTimeout(() => clearFinishedAgents(s, AGENT_LINGER_MS), AGENT_LINGER_MS + 50);
}

function markInterrupted(s) {
  s.status = "interrupted";
  s.activity = "Interrupted";
  for (const a of s.agents || []) if (a.status === "working" && !a.background) {
    a.status = "done"; a.activity = "Stopped"; a.doneAt = Date.now();
  }
  setTimeout(() => clearFinishedAgents(s, 3000), 3050);
}

// usage limit / API error: the turn ended without Claude finishing
function markFailed(s, kind, text) {
  const msg = String(text || "").replace(/^API Error:\s*/i, "").replace(/\s+/g, " ").trim();
  const limit = kind === "rate_limit" || /limit/i.test(msg);
  s.status = limit ? "limit" : "error";
  s.activity = msg || (limit ? "Usage limit reached" : "Something went wrong");
  for (const a of s.agents || []) if (a.status === "working" && !a.background) {
    a.status = "done"; a.activity = "Stopped"; a.doneAt = Date.now();
  }
  setTimeout(() => clearFinishedAgents(s, 3000), 3050);
}

function clearFinishedAgents(s, olderThan) {
  const before = s.agents?.length || 0;
  s.agents = (s.agents || []).filter((a) => a.status !== "done" || Date.now() - a.doneAt < olderThan);
  if (s.agents.length !== before) push();
}

// returns true when the event belonged to a subagent (and was handled here)
function applyAgentEvent(s, e, ti) {
  const ev = e.hook_event_name;
  if (ev === "SubagentStart") {
    const a = getAgent(s, e.agent_id, e.agent_type);
    a.hookAt = Date.now();
    a.status = "working";
    a.activity = "Starting";
    return true;
  }
  if (ev === "SubagentStop") {
    const a = findAgent(s, e.agent_id) || newAgent(s, e.agent_id, e.agent_type);
    finishAgent(s, a, e.last_assistant_message);
    return true;
  }
  // tool calls etc. fired inside a subagent carry agent_id
  if (!e.agent_id || !["PreToolUse", "PostToolUse", "PermissionRequest", "Notification"].includes(ev)) return false;
  const a = getAgent(s, e.agent_id, e.agent_type);
  a.hookAt = Date.now();
  if (a.status === "done") return true;
  if (ev === "PreToolUse" && e.tool_name !== "AskUserQuestion") {
    a.activity = describeTool(e.tool_name, ti);
    if (e.tool_name === "TodoWrite" && Array.isArray(ti.todos)) {
      a.todos = ti.todos.map((t) => ({ text: t.content || "", active: t.activeForm || t.content || "", status: t.status || "pending" }));
    }
  }
  if (ev === "PermissionRequest") a.activity = describeTool(e.tool_name, ti);
  if (ev === "PostToolUse" && (e.tool_name === "Bash" || e.tool_name === "PowerShell")) {
    const r = e.tool_response || {};
    const out = typeof r === "string" ? r : [r.stdout, r.stderr].filter(Boolean).join("\n");
    a.terminal = { cmd: ti.command || "", out: String(out || "").trim().split("\n").slice(-6).join("\n") };
  }
  // PreToolUse(AskUserQuestion) + PermissionRequest still need the hold() flow below
  return !(ev === "PermissionRequest" || (ev === "PreToolUse" && e.tool_name === "AskUserQuestion"));
}

function applyEvent(e) {
  if (!e.session_id) return;
  if (e.hook_event_name === "SessionEnd") {
    sessions.delete(e.session_id);
    return;
  }
  const s = getSession(e);
  s.hookAt = Date.now();
  dismissed.delete(e.session_id);
  const ti = e.tool_input || {};
  s.agents ||= [];

  if (applyAgentEvent(s, e, ti)) return;

  switch (e.hook_event_name) {
    case "UserPromptSubmit":
      if (!s.task) s.task = taskLabel(e.prompt);
      if (e.prompt) s.lastUser = e.prompt;
      s.status = "working";
      s.activity = "Thinking";
      break;

    case "PreToolUse":
      s.lastTool = e.tool_name;
      if (e.tool_name === "Agent" || e.tool_name === "Task") {
        (s.launches ||= []).push({
          type: ti.subagent_type || "general-purpose",
          desc: ti.description || "",
          prompt: ti.prompt || "",
          background: !!ti.run_in_background,
          toolUseId: e.tool_use_id,
          at: Date.now(),
        });
      }
      if (e.tool_name !== "AskUserQuestion") {
        s.status = "working";
        s.activity = describeTool(e.tool_name, ti);
      }
      if (e.tool_name === "TodoWrite" && Array.isArray(ti.todos)) {
        s.todos = ti.todos.map((t) => ({
          text: t.content || t.subject || "",
          active: t.activeForm || t.content || "",
          status: t.status || "pending",
        }));
      }
      if (e.tool_name === "TaskUpdate") {
        const t = s.todos.find((x) => String(x.id) === String(ti.taskId || ti.task_id || ti.id));
        if (t && ti.status) t.status = ti.status === "deleted" ? "deleted" : ti.status;
        s.todos = s.todos.filter((x) => x.status !== "deleted");
      }
      break;

    case "PostToolUse": {
      if ((e.tool_name === "Agent" || e.tool_name === "Task") && !ti.run_in_background) {
        const a = s.agents.find((x) => x.status === "working" && x.desc && x.desc === ti.description);
        if (a) finishAgent(s, a, "");
      }
      if (e.tool_name === "Bash" || e.tool_name === "PowerShell") {
        const r = e.tool_response || {};
        const out = typeof r === "string" ? r : [r.stdout, r.stderr].filter(Boolean).join("\n");
        s.terminal = { cmd: ti.command || "", out: String(out || "").trim().split("\n").slice(-6).join("\n") };
      }
      if (e.tool_name === "TaskCreate") {
        const r = e.tool_response || {};
        const id = r.task?.id ?? r.id ?? r.taskId;
        if (id != null && !s.todos.some((x) => String(x.id) === String(id))) {
          s.todos.push({ id, text: ti.subject || "", active: ti.activeForm || ti.subject || "", status: "pending" });
        }
      }
      if (s.status === "needs_permission" || s.status === "question") s.status = "working";
      break;
    }

    case "TaskCreated":
      if (!s.todos.some((x) => String(x.id) === String(e.task_id))) {
        s.todos.push({ id: e.task_id, text: e.task_subject || "", active: e.task_subject || "", status: "pending" });
      }
      break;

    case "TaskCompleted": {
      const t = s.todos.find((x) => String(x.id) === String(e.task_id));
      if (t) t.status = "completed";
      break;
    }

    case "PermissionRequest":
      s.status = "needs_permission";
      s.activity = describeTool(e.tool_name, ti);
      break;

    case "Notification":
      if (e.notification_type === "idle_prompt" && !s.pending && !["interrupted", "limit", "error"].includes(s.status)) {
        s.status = "waiting";
        s.activity = "Waiting for you";
      }
      break;

    case "StopFailure":
      markFailed(s, e.error, e.last_assistant_message || e.error_details || "");
      break;

    case "Stop":
      clearFinishedAgents(s, 4000);
      if (e.last_assistant_message) s.lastReply = e.last_assistant_message;
      if (!s.pending) {
        s.status = "done";
        s.activity = "Finished";
      }
      break;
  }
}

function publicState() {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.updatedAt > STALE_MS && !s.pending) sessions.delete(id);
  return [...sessions.values()].sort((a, b) => a.createdAt - b.createdAt);
}

function push() {
  if (win && !win.isDestroyed()) win.webContents.send("state", publicState());
}

// ---------- blocking requests (permissions + questions) ----------
function hold(e, res, kind) {
  const id = String(++reqCounter);
  const s = getSession(e);
  pending.set(id, { res, sessionId: s.id, kind, event: e });
  s.pending = {
    id,
    agentId: e.agent_id ? String(e.agent_id) : null,
    kind,
    tool: e.tool_name,
    input: e.tool_input || {},
  };
  s.status = kind === "question" ? "question" : "needs_permission";
  if (kind === "question") s.activity = "asks a question";
  res.on("close", () => {
    // Claude Code cancelled (Esc, timeout) — drop the prompt
    if (pending.has(id)) {
      pending.delete(id);
      if (s.pending?.id === id) {
        s.pending = null;
        s.status = "working";
      }
      push();
    }
  });
  if (win && !win.isDestroyed()) win.webContents.send("attention", s.id);
  needsYou(s, kind);
}

function respond(id, body) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  const s = sessions.get(p.sessionId);
  if (s && s.pending?.id === id) s.pending = null;
  p.res.writeHead(200, { "Content-Type": "application/json" });
  p.res.end(body ? JSON.stringify(body) : "");
  return { p, s };
}

ipcMain.on("decide", (_ev, { id, action, answers }) => {
  const p = pending.get(id);
  if (!p) return;
  const s = sessions.get(p.sessionId);

  if (action === "vscode") {
    respond(id, null); // empty = Claude Code shows its normal prompt
    if (s) { s.status = "waiting"; s.activity = "Answer in VS Code"; }
    openInVSCode(s?.cwd);
  } else if (p.kind === "permission") {
    const allow = action === "allow";
    respond(id, {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: allow ? { behavior: "allow" } : { behavior: "deny", message: "Denied from Agent Tren" },
      },
    });
    if (s) {
      s.status = "working";
      s.flash = allow ? "Allowed ✓" : "Denied ✕";
      setTimeout(() => { s.flash = null; push(); }, 2500);
    }
  } else if (p.kind === "question") {
    respond(id, {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { ...p.event.tool_input, answers },
      },
    });
    if (s) { s.status = "working"; s.activity = "Thinking"; s.flash = "Answered ✓"; setTimeout(() => { s.flash = null; push(); }, 2500); }
  }
  push();
});

ipcMain.on("dismiss", (_ev, sessionId) => {
  const s = sessions.get(sessionId);
  if (s?.pending) respond(s.pending.id, null);
  sessions.delete(sessionId);
  dismissed.set(sessionId, Date.now());
  saveDismissed();
  push();
});

ipcMain.on("open-vscode", (_ev, sessionId) => openInVSCode(sessions.get(sessionId)?.cwd));
ipcMain.on("resize", (_ev, h) => {
  wantedHeight = Math.ceil(h);
  fitWindow();
});
ipcMain.on("hide", () => hideWidget());
ipcMain.on("connect", () => askConnect(true));
ipcMain.on("collapsed", (_ev, v) => { prefs.collapsed = !!v; savePrefs(); });
ipcMain.on("muted", (_ev, v) => { prefs.muted = !!v; savePrefs(); buildTrayMenu(); });

function openInVSCode(cwd) {
  if (!cwd) return;
  exec(`code "${cwd.replace(/"/g, "")}"`, { windowsHide: true });
}


// ---------- transcripts: pick up sessions that were already open ----------
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");

function readChunk(file, fromEnd, bytes) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, fromEnd ? size - len : 0);
    const lines = buf.toString("utf8").split("\n");
    if (fromEnd && len < size) lines.shift(); // first line is cut
    if (!fromEnd && len < size) lines.pop(); // last line is cut
    return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } finally { fs.closeSync(fd); }
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

// a real prompt typed by the user (not tool results, commands or system notes)
function userPrompt(entry) {
  if (entry.type !== "user" || entry.isMeta || entry.isSidechain) return null;
  const c = entry.message?.content;
  if (Array.isArray(c) && c.some((b) => b.type === "tool_result")) return null;
  const t = textOf(c).trim();
  if (!t || t.startsWith("<") || t.startsWith("Caveat:") || t.startsWith("[Request interrupted")) return null;
  return t;
}

function scanTranscript(file) {
  let st;
  try { st = fs.statSync(file); } catch { return; }
  if (Date.now() - st.mtimeMs > STALE_MS) return;
  const id = path.basename(file, ".jsonl");
  const gone = dismissed.get(id);
  if (gone && st.mtimeMs <= gone) return;

  let head, tail;
  try {
    head = readChunk(file, false, 256 * 1024);
    tail = readChunk(file, true, 1024 * 1024);
  } catch { return; }
  const main = tail.filter((e) => !e.isSidechain);
  if (!main.length) return;

  const cwd = [...main].reverse().find((e) => e.cwd)?.cwd || head.find((e) => e.cwd)?.cwd;
  if (!cwd) return;
  const s = getSession({ session_id: id, cwd });
  s.updatedAt = Math.max(s.updatedAt || 0, st.mtimeMs);
  const started = Date.parse(head.find((e) => e.timestamp)?.timestamp || "");
  if (started && started < s.createdAt) s.createdAt = started;

  // title: a saved session title, else the first prompt
  const titled = [...head, ...tail].reverse().find((e) => /title|summary/i.test(e.type || "") && (e.title || e.customTitle || e.aiTitle || e.summary));
  const firstPrompt = head.map(userPrompt).find(Boolean);
  if (titled) s.task = taskLabel(titled.title || titled.customTitle || titled.aiTitle || titled.summary);
  else if (!s.task && firstPrompt) s.task = taskLabel(firstPrompt);

  // latest messages
  for (let i = main.length - 1; i >= 0; i--) { const t = userPrompt(main[i]); if (t) { s.lastUser = t; break; } }
  for (let i = main.length - 1; i >= 0; i--) {
    const e = main[i];
    if (e.type === "assistant" && !e.isApiErrorMessage) {
      const t = textOf(e.message?.content).trim();
      if (t && !/^(you've hit your .*limit|claude ai usage limit reached|api error)/i.test(t)) { s.lastReply = t; break; }
    }
  }

  // latest task list + terminal
  for (let i = main.length - 1; i >= 0; i--) {
    const blocks = main[i].type === "assistant" && Array.isArray(main[i].message?.content) ? main[i].message.content : [];
    const todo = blocks.find((b) => b.type === "tool_use" && b.name === "TodoWrite" && Array.isArray(b.input?.todos));
    if (todo) {
      s.todos = todo.input.todos.map((t) => ({ text: t.content || "", active: t.activeForm || t.content || "", status: t.status || "pending" }));
      break;
    }
  }

  const last = [...main].reverse().find((e) => e.type === "user" || e.type === "assistant");

  // you pressed stop / Esc: Claude Code fires no hook for that, but writes it here
  if (last?.type === "user" && JSON.stringify(last.message?.content || "").includes("Request interrupted by user")) {
    if (!s.pending) markInterrupted(s);
    return;
  }

  // usage limit / API error written as Claude's last message
  if (last?.type === "assistant") {
    const t = textOf(last.message?.content).trim();
    if (last.isApiErrorMessage || /^(you've hit your .*limit|claude ai usage limit reached|api error)/i.test(t)) {
      if (!s.pending) markFailed(s, /limit/i.test(t) ? "rate_limit" : "error", t);
      return;
    }
  }

  // Once hooks report for this session they are the source of truth for
  // working / waiting / finished. A quiet file only means a long command or long thinking.
  if (s.pending || s.hookAt) return;

  // No hooks for this session (not connected yet, or the widget started mid-turn): best guess.
  const lastBlocks = Array.isArray(last?.message?.content) ? last.message.content : [];
  if (last?.type === "assistant" && !lastBlocks.some((b) => b.type === "tool_use")) {
    // Claude often writes a short line ("Running the tests…") right before a tool call:
    // only call it finished if nothing follows for a few seconds
    if (Date.now() - st.mtimeMs < 4000) {
      recheckLater(file, () => scanTranscript(file), 4100);
      return;
    }
    s.status = "done";
    s.activity = "Your turn";
  } else {
    s.status = "working";
    const tu = [...lastBlocks].reverse().find((b) => b.type === "tool_use");
    s.activity = tu ? describeTool(tu.name, tu.input) : "Thinking";
  }
}

const recheckTimers = new Map(); // file -> timer (kept out of session state: timers can't go over IPC)
function recheckLater(file, fn, ms) {
  clearTimeout(recheckTimers.get(file));
  recheckTimers.set(file, setTimeout(() => { recheckTimers.delete(file); fn(); push(); }, ms));
}

// projects/<project>/<sessionId>/subagents/agent-<id>.jsonl
const SUBAGENT_RE = /[\\/]subagents[\\/]agent-([^\\/]+)\.jsonl$/;
const AGENT_QUIET_MS = 5 * 60 * 1000; // no output for this long -> treat as stopped (only without hooks)
const AGENT_TOOL_QUIET_MS = 10 * 60 * 1000; // ...unless it is waiting on a long tool call

function parentFileOf(file) {
  const sessionDir = path.dirname(path.dirname(file));
  return { sessionId: path.basename(sessionDir), parentFile: sessionDir + ".jsonl" };
}

// find the Agent tool call in the parent that started this agent (gives type + description)
function findLaunch(parentFile, prompt) {
  if (!prompt) return null;
  let entries = [];
  try { entries = readChunk(parentFile, true, 3 * 1024 * 1024); } catch { return null; }
  const want = prompt.trim().slice(0, 300);
  for (let i = entries.length - 1; i >= 0; i--) {
    const blocks = entries[i].type === "assistant" && Array.isArray(entries[i].message?.content) ? entries[i].message.content : [];
    for (const b of blocks) {
      if (b.type === "tool_use" && (b.name === "Agent" || b.name === "Task") && String(b.input?.prompt || "").trim().slice(0, 300) === want) {
        return { type: b.input.subagent_type || "general-purpose", desc: b.input.description || "", background: !!b.input.run_in_background };
      }
    }
  }
  return null;
}

function scanSubagent(file) {
  const m = SUBAGENT_RE.exec(file);
  if (!m) return;
  let st;
  try { st = fs.statSync(file); } catch { return; }
  const id = m[1];
  const { sessionId, parentFile } = parentFileOf(file);
  if (dismissed.has(sessionId)) return;

  let s = sessions.get(sessionId);
  if (!s) { scanTranscript(parentFile); s = sessions.get(sessionId); }
  if (!s) return;
  s.agents ||= [];
  let a = findAgent(s, id);
  const age = Date.now() - st.mtimeMs;
  if (!a && age > AGENT_QUIET_MS) return; // old agent we never saw: don't resurrect it

  let head, tail;
  try { head = readChunk(file, false, 128 * 1024); tail = readChunk(file, true, 512 * 1024); } catch { return; }
  const firstPrompt = head.map((e) => (e.type === "user" ? textOf(e.message?.content).trim() : "")).find(Boolean) || "";
  const last = [...tail].reverse().find((e) => e.type === "user" || e.type === "assistant");
  const lastBlocks = Array.isArray(last?.message?.content) ? last.message.content : [];
  const lastText = last?.type === "assistant" ? textOf(last.message?.content).trim() : "";
  const finished = last?.type === "assistant" && !lastBlocks.some((b) => b.type === "tool_use") && !!lastText;

  if (!a) {
    if (finished && age > AGENT_LINGER_MS) return;
    const launch = findLaunch(parentFile, firstPrompt);
    const meta = (() => { try { return JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8")); } catch { return {}; } })();
    const type = launch?.type || meta.agentType || head.find((e) => e.agentType)?.agentType || "agent";
    a = {
      id, parent: s.id, type,
      desc: launch?.desc || meta.description || taskLabel(firstPrompt),
      prompt: firstPrompt, background: launch?.background || false,
      status: "working", activity: "Starting", todos: [], lastReply: "", startedAt: Date.now(),
    };
    s.agents.push(a);
    // this launch is taken, so the hook flow doesn't give its name to another agent
    if (s.launches) { const i = s.launches.findIndex((l) => l.prompt && l.prompt.trim() === firstPrompt); if (i >= 0) s.launches.splice(i, 1); }
  }
  if (!a.prompt) a.prompt = firstPrompt;
  if (a.status === "done") return;

  // latest to-dos + what it's doing
  for (let i = tail.length - 1; i >= 0; i--) {
    const blocks = tail[i].type === "assistant" && Array.isArray(tail[i].message?.content) ? tail[i].message.content : [];
    const todo = blocks.find((b) => b.type === "tool_use" && b.name === "TodoWrite" && Array.isArray(b.input?.todos));
    if (todo) { a.todos = todo.input.todos.map((t) => ({ text: t.content || "", active: t.activeForm || t.content || "", status: t.status || "pending" })); break; }
  }
  const lastTool = [...lastBlocks].reverse().find((b) => b.type === "tool_use");

  if (finished) {
    // without hooks: finished once nothing follows for 4s; with hooks we wait for
    // SubagentStop, but still finish it after 30s in case that event never comes
    const wait = a.hookAt ? 30000 : 4000;
    if (age >= wait) return finishAgent(s, a, lastText);
    recheckLater(file, () => scanSubagent(file), wait - age + 100);
  }
  const waitingOnTool = last?.type === "assistant" && !!lastTool;
  const quietTooLong = !a.hookAt && age > (waitingOnTool ? AGENT_TOOL_QUIET_MS : AGENT_QUIET_MS);
  if (quietTooLong || ["interrupted", "limit", "error"].includes(s.status)) {
    a.status = "done"; a.activity = "Stopped"; a.doneAt = Date.now();
    setTimeout(() => clearFinishedAgents(s, 3000), 3050);
    return;
  }
  if (lastTool) a.activity = describeTool(lastTool.name, lastTool.input);
  else if (last?.type === "user") a.activity = "Thinking";
}

function scanAllTranscripts() {
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return; }
  for (const d of dirs) {
    const dir = path.join(PROJECTS_DIR, d.name);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) scanTranscript(path.join(dir, f));
    // agents of sessions in this project
    for (const f of files) {
      const subDir = path.join(dir, f.replace(/\.jsonl$/, ""), "subagents");
      let subs = [];
      try { subs = fs.readdirSync(subDir).filter((x) => /^agent-.*\.jsonl$/.test(x)); } catch { continue; }
      for (const x of subs) scanSubagent(path.join(subDir, x));
    }
  }
  push();
}

const rescanTimers = new Map();
function watchTranscripts() {
  try {
    fs.watch(PROJECTS_DIR, { recursive: true }, (_type, name) => {
      if (!name || !String(name).endsWith(".jsonl")) return;
      const file = path.join(PROJECTS_DIR, String(name));
      const isAgent = SUBAGENT_RE.test(file);
      if (!isAgent && /subagents|[\\/]agent-/.test(String(name))) return;
      clearTimeout(rescanTimers.get(file));
      rescanTimers.set(file, setTimeout(() => { isAgent ? scanSubagent(file) : scanTranscript(file); push(); }, 300));
    });
  } catch (err) {
    console.error("Can't watch transcripts:", err.message);
  }
  setInterval(scanAllTranscripts, 20000); // catch status changes like "waiting" or stopped agents
}

// ---------- event log: what Claude Code actually sent (tray > Open event log) ----------
let logFile;
function logEvent(e) {
  try {
    logFile ||= path.join(app.getPath("userData"), "events.log");
    const slim = { t: new Date().toISOString(), ...e };
    delete slim.tool_response; // can be huge
    if (slim.tool_input) slim.tool_input = JSON.parse(JSON.stringify(slim.tool_input, (k, v) => (typeof v === "string" && v.length > 300 ? v.slice(0, 300) + "…" : v)));
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2 * 1024 * 1024) fs.renameSync(logFile, logFile + ".old");
    fs.appendFileSync(logFile, JSON.stringify(slim) + "\n");
  } catch {}
}

// ---------- HTTP hook server ----------
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/hook") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let e;
      try { e = JSON.parse(body); } catch { res.writeHead(200); return res.end(); }

      logEvent(e);
      applyEvent(e);

      if (e.hook_event_name === "PermissionRequest" && e.tool_name !== "AskUserQuestion") {
        hold(e, res, "permission");
      } else if (e.hook_event_name === "PreToolUse" && e.tool_name === "AskUserQuestion") {
        hold(e, res, "question");
      } else {
        res.writeHead(200);
        res.end();
      }
      push();
    });
    return;
  }
  if (req.method === "GET" && req.url === "/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(publicState(), null, 2));
  }
  res.writeHead(404);
  res.end();
});

// ---------- preferences ----------
let prefs = { muted: false, collapsed: false, pos: null, corner: "tr", dockDisplay: null, firstRunDone: false, trayTipShown: false };
let prefsFile;
function loadPrefs() {
  prefsFile = path.join(app.getPath("userData"), "preferences.json");
  try { prefs = { ...prefs, ...JSON.parse(fs.readFileSync(prefsFile, "utf8")) }; } catch {}
}
function savePrefs() {
  try { fs.writeFileSync(prefsFile, JSON.stringify(prefs, null, 2)); } catch {}
}

// ---------- window position ----------
// prefs.pos === null  -> docked in a corner: prefs.corner = "tr" | "tl" | "br" | "bl" (default "tr")
// prefs.pos = {x,y}   -> where you dropped it; outside:true if you dragged it past the screen edge
let wantedHeight = 60;
let programmatic = false;
let wentOutside = false;
let dragging = false; // only real mouse drags count (Windows emits "will-move" for those)
const CORNERS = ["tr", "tl", "br", "bl"];

const workAreaFor = (b) => screen.getDisplayMatching(b).workArea;
const panelOf = (b) => ({ x: b.x + INSET, y: b.y + INSET, width: b.width - INSET * 2, height: b.height - INSET * 2 });
function panelInside(b) {
  const p = panelOf(b);
  return screen.getAllDisplays().some(({ workArea: a }) =>
    p.x >= a.x && p.y >= a.y && p.x + p.width <= a.x + a.width && p.y + p.height <= a.y + a.height);
}
// window position that puts the panel exactly GAP away from both edges of a corner.
// Bottom corners are anchored at the bottom, so the widget grows upward there.
function cornerPos(a, corner = "tr", height = wantedHeight) {
  const left = a.x + GAP - INSET, right = a.x + a.width - GAP - WIDTH + INSET;
  const top = a.y + GAP - INSET, bottom = a.y + a.height - GAP - height + INSET;
  return { x: corner[1] === "l" ? left : right, y: corner[0] === "t" ? top : bottom };
}
function maxHeight(a) { return a.height - GAP * 2 + INSET * 2; }
function dockArea() {
  const d = screen.getAllDisplays().find((x) => x.id === prefs.dockDisplay) || screen.getPrimaryDisplay();
  return d.workArea;
}

function setBoundsQuiet(b) {
  programmatic = true;
  win.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: WIDTH, height: Math.round(b.height) });
  setTimeout(() => (programmatic = false), 150);
}

// size the window to its content and keep it on screen
function fitWindow() {
  if (!win) return;
  const b = win.getBounds();

  if (!prefs.pos) {
    const a = dockArea();
    const height = Math.max(48, Math.min(wantedHeight, maxHeight(a)));
    return setBoundsQuiet({ ...cornerPos(a, prefs.corner || "tr", height), height });
  }
  const a = workAreaFor(b);
  const height = Math.max(48, Math.min(wantedHeight, maxHeight(a)));
  if (prefs.pos.outside) return setBoundsQuiet({ x: b.x, y: b.y, height }); // you put it there

  // keep the gap on every side: slide up/left if it would grow past an edge
  let { x, y } = b;
  const minX = a.x + GAP - INSET, maxX = a.x + a.width - GAP - WIDTH + INSET;
  const minY = a.y + GAP - INSET, maxY = a.y + a.height - GAP - height + INSET;
  x = Math.min(Math.max(x, minX), maxX);
  y = Math.min(Math.max(y, minY), maxY);
  setBoundsQuiet({ x, y, height });
}

function dock(corner = "tr", displayId = screen.getPrimaryDisplay().id) {
  prefs.pos = null;
  prefs.corner = corner;
  prefs.dockDisplay = displayId;
  savePrefs();
  fitWindow();
}

function startPos() {
  const p = prefs.pos;
  if (!p) return cornerPos(dockArea(), prefs.corner || "tr", 60);
  const b = { x: p.x, y: p.y, width: WIDTH, height: 60 };
  const visible = screen.getAllDisplays().some(({ workArea: w }) =>
    b.x < w.x + w.width && b.x + b.width > w.x && b.y < w.y + w.height && b.y + 40 > w.y);
  if ((p.outside && visible) || panelInside(b)) return p;
  prefs.pos = null; // its monitor is gone — back to the corner
  return cornerPos(dockArea(), prefs.corner || "tr", 60);
}

function nearestCorner(b) {
  const a = workAreaFor(b);
  return CORNERS
    .map((c) => { const p = cornerPos(a, c, b.height); return { c, dist: Math.hypot(b.x - p.x, b.y - p.y) }; })
    .sort((x, y) => x.dist - y.dist)[0];
}

function trackDragging() {
  win.on("will-move", () => { if (!programmatic) dragging = true; });
  win.on("move", () => {
    if (!dragging) return;
    if (!panelInside(win.getBounds())) wentOutside = true;
  });
  win.on("moved", () => {
    if (!dragging) return;
    dragging = false;
    const b = win.getBounds();
    const inside = panelInside(b);
    const near = nearestCorner(b);
    const displayId = screen.getDisplayMatching(b).id;

    // dropped near a corner, or dragged off-screen and back: lock into the nearest corner
    if (inside && (wentOutside || near.dist < SNAP)) dock(near.c, displayId);
    else {
      prefs.pos = { x: b.x, y: b.y, outside: !inside };
      savePrefs();
      if (inside) fitWindow(); // nudge back inside the gap if needed
    }
    wentOutside = false;
  });
  // monitor unplugged, resolution or taskbar changed
  const refit = () => { if (prefs.pos && !prefs.pos.outside && !panelInside(win.getBounds())) prefs.pos = null; fitWindow(); };
  screen.on("display-removed", refit);
  screen.on("display-added", refit);
  screen.on("display-metrics-changed", refit);
}

function createWindow() {
  const pos = startPos();
  win = new BrowserWindow({
    width: WIDTH,
    height: 60,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: "Agent Tren",
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true);
  win.setMenu(null);
  win.loadFile("index.html");
  win.webContents.on("did-finish-load", () => {
    win.webContents.send("prefs", { muted: prefs.muted, collapsed: prefs.collapsed, connected: claude.status(PORT) === "connected" });
    push();
  });
  win.once("ready-to-show", () => win.showInactive());
  trackDragging();
  // links in Claude's messages open in the browser, never inside the widget
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
}

function showWidget() { if (win) { win.showInactive(); win.moveTop(); buildTrayMenu(); } }
function hideWidget() {
  if (!win) return;
  win.hide();
  buildTrayMenu();
  if (!prefs.trayTipShown && tray) {
    tray.displayBalloon?.({ iconType: "info", title: "Agent Tren is still running", content: "It lives in the tray. Click the icon or press Ctrl+Shift+Space to bring it back." });
    prefs.trayTipShown = true;
    savePrefs();
  }
}
function toggleWidget() { win?.isVisible() ? hideWidget() : showWidget(); }
function resetPosition() {
  dock();
  showWidget();
}

// a session needs you: bring the widget back + Windows notification
function needsYou(s, kind) {
  const hidden = win && !win.isVisible();
  if (hidden) showWidget();
  if ((hidden || prefs.collapsed) && Notification.isSupported()) {
    const n = new Notification({
      title: titleFor(s),
      body: kind === "question" ? "Claude has a question for you" : `Needs permission: ${s.activity || s.pending?.tool || ""}`,
      icon: path.join(__dirname, "build", "icon.png"),
      silent: prefs.muted,
    });
    n.on("click", showWidget);
    n.show();
  }
}
function titleFor(s) { return s.task ? `${s.project} · ${s.task}` : s.project; }

// ---------- tray ----------
let tray;
const SHORTCUT = "CommandOrControl+Shift+Space";

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, "build", "tray.png"));
  img.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(path.join(__dirname, "build", "tray@2x.png")) });
  tray = new Tray(img);
  tray.setToolTip("Agent Tren");
  tray.on("click", toggleWidget);
  buildTrayMenu();
}

function buildTrayMenu() {
  if (!tray) return;
  const conn = claude.status(PORT);
  win?.webContents.send("prefs", { connected: conn === "connected" });
  const login = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: win?.isVisible() ? "Hide widget" : "Show widget", accelerator: SHORTCUT, click: toggleWidget },
    { label: "Snap to top-right corner", click: resetPosition },
    { type: "separator" },
    conn === "connected"
      ? { label: "✓ Connected to Claude Code", enabled: false }
      : { label: conn === "broken" ? "⚠ Claude Code settings can't be read" : "Connect to Claude Code…", click: () => askConnect(true) },
    ...(conn === "connected" ? [{ label: "Disconnect from Claude Code", click: doDisconnect }] : []),
    { type: "separator" },
    { label: "Sounds", type: "checkbox", checked: !prefs.muted, click: (m) => { prefs.muted = !m.checked; savePrefs(); win?.webContents.send("prefs", { muted: prefs.muted }); } },
    { label: "Start with Windows", type: "checkbox", checked: login, enabled: app.isPackaged, click: (m) => { app.setLoginItemSettings({ openAtLogin: m.checked }); buildTrayMenu(); } },
    { type: "separator" },
    { label: "Open event log", click: () => { const f = path.join(app.getPath("userData"), "events.log"); if (!fs.existsSync(f)) fs.writeFileSync(f, ""); shell.openPath(f); } },
    { label: "About Agent Tren", click: showAbout },
    { label: "Quit Agent Tren", click: () => app.quit() },
  ]));
}

const HOMEPAGE = require("./package.json").homepage;
function showAbout() {
  dialog.showMessageBox({
    type: "none",
    icon: nativeImage.createFromPath(path.join(__dirname, "build", "icon.png")).resize({ width: 64, height: 64 }),
    title: "About Agent Tren",
    message: `Agent Tren ${app.getVersion()}`,
    detail: "A little widget that keeps an eye on your Claude Code sessions.\n\nShow / hide: Ctrl+Shift+Space\nCreated by Jure M",
    buttons: ["OK", "View on GitHub"],
    defaultId: 0,
  }).then(({ response }) => { if (response === 1) shell.openExternal(HOMEPAGE); });
}

// ---------- Claude Code connection ----------
async function askConnect(fromMenu) {
  const st = claude.status(PORT);
  if (st === "connected") return;
  if (st === "broken") {
    await dialog.showMessageBox({
      type: "warning",
      title: "Agent Tren",
      message: "Claude Code's settings file can't be read",
      detail: `${claude.SETTINGS} isn't valid JSON, so Agent Tren won't touch it. Fix the file, then choose "Connect to Claude Code" from the tray menu.`,
    });
    return buildTrayMenu();
  }
  const { response } = await dialog.showMessageBox({
    type: "question",
    title: "Agent Tren",
    message: "Connect Agent Tren to Claude Code?",
    detail: `Agent Tren adds a few hooks to ${claude.SETTINGS} so your sessions report to the widget. Your other settings stay as they are, and a backup is saved next to the file.\n\nReload VS Code (or restart Claude Code) afterwards.`,
    buttons: ["Connect", fromMenu ? "Cancel" : "Not now"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) {
    try {
      claude.connect(PORT);
      new Notification({ title: "Agent Tren connected", body: "Reload VS Code so Claude Code picks up the change.", icon: path.join(__dirname, "build", "icon.png") }).show();
    } catch (err) {
      dialog.showErrorBox("Agent Tren", `Couldn't update Claude Code settings:\n${err.message}`);
    }
  }
  buildTrayMenu();
}

async function doDisconnect() {
  try { claude.disconnect(PORT); } catch (err) { dialog.showErrorBox("Agent Tren", err.message); }
  buildTrayMenu();
}

// ---------- start ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.setAppUserModelId("com.jurematis.agenttren"); // Windows notifications show the app name + icon
  app.on("second-instance", showWidget);

  app.whenReady().then(async () => {
    loadPrefs();
    loadDismissed();

    server.on("error", async (err) => {
      await dialog.showMessageBox({
        type: "error",
        title: "Agent Tren",
        message: err.code === "EADDRINUSE" ? `Port ${PORT} is already in use` : "Agent Tren couldn't start",
        detail: err.code === "EADDRINUSE"
          ? "Something else is using it — most likely an old `node server.js` window. Close it and start Agent Tren again."
          : err.message,
      });
      app.quit();
    });
    server.listen(PORT, "127.0.0.1");

    if (app.isPackaged && !prefs.firstRunDone) app.setLoginItemSettings({ openAtLogin: true });

    createWindow();
    createTray();
    globalShortcut.register(SHORTCUT, toggleWidget);
    scanAllTranscripts();
    watchTranscripts();
    setInterval(push, 30000);

    if (claude.status(PORT) === "outdated") { try { claude.connect(PORT); } catch {} }
    if (!prefs.firstRunDone && claude.status(PORT) !== "connected") setTimeout(() => askConnect(false), 1200);
    prefs.firstRunDone = true;
    savePrefs();
  });

  app.on("will-quit", () => globalShortcut.unregisterAll());
  app.on("window-all-closed", (e) => e.preventDefault()); // keep running in the tray
}
