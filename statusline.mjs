#!/usr/bin/env node
// Context Meter status line. Claude Code runs this for every session after
// each reply, with that session's JSON on stdin. It records the session's
// context usage (sessions/<id>.json) and the account's plan usage
// (limits.json) for the menu bar app, sends a macOS notification the first
// time either crosses a threshold, then prints the previous status line
// (chained at install) or a short default one.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const BASE = join(homedir(), ".claude", "context-meter");
const SESSIONS = join(BASE, "sessions");
const LIMITS = join(BASE, "limits.json");
const LIMIT_WINDOWS = [
  ["five_hour", "5-hour"],
  ["seven_day", "Weekly"],
  ["spend_limit", "Spend"],
];
// Matches the claude CLI in a `ps` command line (npm, native or symlinked
// install) but not paths like ~/.claude/context-meter/statusline.mjs.
const CLAUDE_COMMAND = /(?:^|[\s/])claude(?:\s|$)|\/claude\/versions\//;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
}

function tokens(n) {
  return n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`;
}

function untilText(resetsAt) {
  if (typeof resetsAt !== "number") return "";
  const minutes = Math.round((resetsAt * 1000 - Date.now()) / 60_000);
  if (minutes <= 0) return "";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return ` · resets in ${days}d ${hours}h`;
  return ` · resets in ${hours ? `${hours}h ` : ""}${minutes % 60}m`;
}

function usage(input) {
  const window = input.context_window ?? {};
  const size = window.context_window_size ?? null;
  const current = window.current_usage;
  const used = current
    ? (current.input_tokens ?? 0) +
      (current.cache_creation_input_tokens ?? 0) +
      (current.cache_read_input_tokens ?? 0)
    : null;
  let pct = typeof window.used_percentage === "number" ? window.used_percentage : null;
  if (pct === null && used !== null && size) pct = (used / size) * 100;
  return { pct, used, size };
}

// Walks up from our parent to the claude process, so the menu bar app can
// tell an idle-but-open session from a closed one.
function findClaudePid() {
  try {
    let pid = process.ppid;
    for (let hop = 0; hop < 6 && pid > 1; hop++) {
      const line = execFileSync("/bin/ps", ["-o", "ppid=,command=", "-p", String(pid)], {
        encoding: "utf8",
      }).trim();
      const match = line.match(/^(\d+)\s+(.*)$/);
      if (!match) return null;
      if (CLAUDE_COMMAND.test(match[2])) return pid;
      pid = Number(match[1]);
    }
  } catch {
    // ps failed; the app falls back to its staleness window.
  }
  return null;
}

// /clear and /resume give the same claude process a new session id; drop the
// old file so the menu does not list the session twice.
function dropOtherFilesForPid(pid, keepId) {
  for (const name of readdirSync(SESSIONS)) {
    if (!name.endsWith(".json") || name === `${keepId}.json`) continue;
    if (readJson(join(SESSIONS, name))?.pid === pid) {
      try {
        unlinkSync(join(SESSIONS, name));
      } catch {
        // Already gone.
      }
    }
  }
}

function osaString(text) {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function sendNotification(title, message) {
  const script = `display notification ${osaString(message)} with title ${osaString(title)} sound name "Glass"`;
  spawn("/usr/bin/osascript", ["-e", script], { detached: true, stdio: "ignore" }).unref();
}

function record(input, thresholds) {
  const id = input.session_id;
  if (typeof id !== "string" || !/^[\w-]+$/.test(id)) return null;
  mkdirSync(SESSIONS, { recursive: true });
  const file = join(SESSIONS, `${id}.json`);
  const previous = readJson(file);
  const { pct, used, size } = usage(input);
  const cwd = input.workspace?.current_dir ?? input.cwd ?? null;
  const projectDir = input.workspace?.project_dir ?? cwd;

  const pid = previous ? (previous.pid ?? null) : findClaudePid();
  if (!previous && pid) dropOtherFilesForPid(pid, id);

  // Re-arm any threshold the session has dropped back under (/compact).
  const notified = new Set((previous?.notified ?? []).filter((t) => pct !== null && pct >= t));
  const crossed = pct === null ? [] : thresholds.filter((t) => pct >= t && !notified.has(t));
  for (const t of crossed) notified.add(t);

  const state = {
    sessionId: id,
    pct,
    usedTokens: used,
    windowSize: size,
    model: input.model?.display_name ?? null,
    cwd,
    project: projectDir ? basename(projectDir) : null,
    updatedAt: Date.now(),
    pid,
    notified: [...notified],
  };
  writeAtomic(file, state);

  if (crossed.length) {
    const model = state.model ? ` (${state.model})` : "";
    sendNotification(
      `Claude context ≥ ${Math.max(...crossed)}%`,
      `${state.project ?? "A Claude session"} is at ${Math.round(pct)}% of its context window${model}.`,
    );
  }
  return state;
}

// Plan usage is account-wide, so every session writes the same file and the
// latest reply wins. Thresholds re-arm when a window resets.
function recordLimits(input, thresholds) {
  const limits = input.rate_limits;
  if (!limits || typeof limits !== "object") return;
  mkdirSync(BASE, { recursive: true });
  const previous = readJson(LIMITS) ?? {};
  const next = { updatedAt: Date.now(), windows: {} };

  for (const [key, label] of LIMIT_WINDOWS) {
    const window = limits[key];
    if (!window || typeof window.used_percentage !== "number") continue;
    const pct = window.used_percentage;
    const resetsAt = typeof window.resets_at === "number" ? window.resets_at : null;
    const before = previous.windows?.[key];
    const sameWindow =
      before && (resetsAt === null || before.resetsAt === null || Math.abs(before.resetsAt - resetsAt) < 300);
    const notified = new Set((sameWindow ? before.notified ?? [] : []).filter((t) => pct >= t));
    const crossed = thresholds.filter((t) => pct >= t && !notified.has(t));
    for (const t of crossed) notified.add(t);

    next.windows[key] = {
      label,
      pct,
      resetsAt,
      usedUsd: window.used_usd ?? null,
      limitUsd: window.limit_usd ?? null,
      period: window.period ?? null,
      notified: [...notified],
    };
    if (crossed.length) {
      sendNotification(
        `Claude plan ≥ ${Math.max(...crossed)}%`,
        `${label} limit at ${Math.round(pct)}%${untilText(resetsAt)}.`,
      );
    }
  }
  writeAtomic(LIMITS, next);
}

function render(raw, input, config, state) {
  if (config.chain) {
    const result = spawnSync("/bin/sh", ["-c", config.chain], {
      input: raw,
      encoding: "utf8",
      timeout: 5000,
    });
    if (result.stdout) return result.stdout.replace(/\n+$/, "");
  }
  const pct = state?.pct;
  let context = pct == null ? "ctx –" : `ctx ${Math.round(pct)}%`;
  if (pct != null && state.usedTokens != null && state.windowSize) {
    context += ` (${tokens(state.usedTokens)}/${tokens(state.windowSize)})`;
  }
  return [input.model?.display_name, state?.project, context].filter(Boolean).join(" · ");
}

const raw = readFileSync(0, "utf8");
let input = {};
try {
  input = JSON.parse(raw);
} catch {
  // Print the default line below.
}
const config = { thresholds: [70, 85], ...readJson(join(BASE, "config.json")) };
const thresholds = (Array.isArray(config.thresholds) ? config.thresholds : [70, 85]).filter(Number.isFinite);
const limitThresholds = (Array.isArray(config.limitThresholds) ? config.limitThresholds : thresholds).filter(
  Number.isFinite,
);

let state = null;
try {
  state = record(input, thresholds);
} catch {
  // Recording must never break the status line.
}
try {
  recordLimits(input, limitThresholds);
} catch {
  // Same.
}
process.stdout.write(render(raw, input, config, state));
