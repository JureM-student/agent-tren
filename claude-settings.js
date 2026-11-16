// Adds / removes Agent Tren's hooks in Claude Code's user settings file
const fs = require("fs");
const path = require("path");
const os = require("os");

const SETTINGS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json");

function hookUrl(port) { return `http://127.0.0.1:${port}/hook`; }

// event -> [needs matcher, timeout seconds]
const EVENTS = {
  UserPromptSubmit: [false, 5],
  PreToolUse: [true, 600], // long: questions wait for your answer
  PostToolUse: [true, 5],
  PermissionRequest: [true, 600], // long: permissions wait for your click
  Notification: [false, 5],
  Stop: [false, 5],
  SessionEnd: [false, 5],
  SubagentStart: [false, 5],
  SubagentStop: [false, 5],
  StopFailure: [false, 5],
};

function read() {
  if (!fs.existsSync(SETTINGS)) return {};
  const raw = fs.readFileSync(SETTINGS, "utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw); // throws if the file is broken — we never overwrite a file we can't read
}

function write(obj) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, SETTINGS + ".agent-tren-backup");
  fs.writeFileSync(SETTINGS, JSON.stringify(obj, null, 2) + "\n");
}

const isOurs = (h, port) => h && h.type === "http" && typeof h.url === "string" && h.url.startsWith(`http://127.0.0.1:${port}/`);

function strip(settings, port) {
  if (!settings.hooks) return;
  for (const ev of Object.keys(settings.hooks)) {
    const groups = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
    settings.hooks[ev] = groups
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h, port)) }))
      .filter((g) => g.hooks.length);
    if (!settings.hooks[ev].length) delete settings.hooks[ev];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
}

// "connected" = every event has our hook with the right timeout
function status(port) {
  try {
    const s = read();
    const ok = Object.entries(EVENTS).every(([ev, [, timeout]]) =>
      (s.hooks?.[ev] || []).some((g) => (g.hooks || []).some((h) => isOurs(h, port) && h.timeout === timeout))
    );
    if (ok) return "connected";
    const any = Object.values(s.hooks || {}).some((groups) => (groups || []).some((g) => (g.hooks || []).some((h) => isOurs(h, port))));
    return any ? "outdated" : "disconnected"; // outdated = connected by an older version
  } catch {
    return "broken";
  }
}

function connect(port) {
  const s = read();
  strip(s, port);
  s.hooks ||= {};
  for (const [ev, [matcher, timeout]] of Object.entries(EVENTS)) {
    const group = { hooks: [{ type: "http", url: hookUrl(port), timeout }] };
    if (matcher) group.matcher = "*";
    (s.hooks[ev] ||= []).push(group);
  }
  write(s);
}

function disconnect(port) {
  const s = read();
  strip(s, port);
  write(s);
}

module.exports = { SETTINGS, status, connect, disconnect };
