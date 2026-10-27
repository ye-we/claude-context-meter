#!/usr/bin/env node
// Installs Context Meter (run it from a clone or from ~/.claude/context-meter):
//   1. copies the sources to ~/.claude/context-meter and builds
//      ContextMeter.app (menu bar) from ContextMeter.swift with swiftc,
//   2. points Claude Code's user statusLine at statusline.mjs, chaining any
//      status line you already had (backed up once, first install only),
//   3. starts the app now and at login via a LaunchAgent.
// Re-running is safe. `node install.mjs --uninstall` restores your previous
// statusLine and removes the LaunchAgent; files in this folder stay.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const BASE = join(HOME, ".claude", "context-meter");
const SOURCE = dirname(fileURLToPath(import.meta.url));
const SOURCE_FILES = ["statusline.mjs", "ContextMeter.swift", "install.mjs"];
const SETTINGS = join(HOME, ".claude", "settings.json");
const SETTINGS_BACKUP = `${SETTINGS}.context-meter-backup`;
const CONFIG = join(BASE, "config.json");
const APP = join(BASE, "ContextMeter.app");
const BINARY = join(APP, "Contents", "MacOS", "ContextMeter");
const LABEL = "local.context-meter";
const AGENT = join(HOME, "Library", "LaunchAgents", `${LABEL}.plist`);
const DOMAIN = `gui/${process.getuid()}`;
const MARKER = "context-meter/statusline.mjs";

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${LABEL}</string>
  <key>CFBundleName</key><string>Context Meter</string>
  <key>CFBundleExecutable</key><string>ContextMeter</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
</dict>
</plist>
`;

const AGENT_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${BINARY}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fail(`Could not parse ${file}; nothing was changed.`);
  }
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args) {
  return execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
}

function quiet(command, args) {
  try {
    run(command, args);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The PATH entry (e.g. /opt/homebrew/bin/node), not the resolved Cellar path,
// so a node upgrade does not break the status line.
function nodePath() {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, "node"))) return join(dir, "node");
  }
  return process.execPath;
}

function install() {
  if (!quiet("/usr/bin/xcrun", ["--find", "swiftc"])) {
    fail("swiftc not found. Install the Xcode Command Line Tools: xcode-select --install");
  }

  // The status line and the app always run from BASE, so a clone can move.
  if (resolve(SOURCE) !== resolve(BASE)) {
    mkdirSync(BASE, { recursive: true });
    for (const name of SOURCE_FILES) copyFileSync(join(SOURCE, name), join(BASE, name));
  }

  quiet("/bin/launchctl", ["bootout", `${DOMAIN}/${LABEL}`]);
  mkdirSync(join(APP, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(APP, "Contents", "Info.plist"), INFO_PLIST);
  console.log("Building ContextMeter.app…");
  try {
    run("/usr/bin/xcrun", ["swiftc", "-O", "-o", BINARY, join(BASE, "ContextMeter.swift")]);
  } catch (error) {
    fail(`Build failed; nothing else was changed.\n${error.stderr || error.message}`);
  }
  quiet("/usr/bin/codesign", ["--force", "--sign", "-", APP]);

  const config = { thresholds: [70, 85], limitThresholds: [70, 85], staleHours: 12, ...readJson(CONFIG, {}) };
  const settings = readJson(SETTINGS, {});
  const previous = settings.statusLine;
  if (previous && !String(previous.command ?? "").includes(MARKER)) {
    config.previousStatusLine = previous;
    config.chain = previous.command ?? null;
  }
  if (existsSync(SETTINGS) && !existsSync(SETTINGS_BACKUP)) copyFileSync(SETTINGS, SETTINGS_BACKUP);
  settings.statusLine = {
    ...(config.previousStatusLine ?? {}),
    type: "command",
    command: `"${nodePath()}" "${join(BASE, "statusline.mjs")}"`,
    padding: config.previousStatusLine?.padding ?? 0,
  };
  writeJson(CONFIG, config);
  writeJson(SETTINGS, settings);

  mkdirSync(join(HOME, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(AGENT, AGENT_PLIST);
  if (!quiet("/bin/launchctl", ["bootstrap", DOMAIN, AGENT])) {
    sleep(1000);
    if (!quiet("/bin/launchctl", ["bootstrap", DOMAIN, AGENT])) {
      fail(`launchctl could not start the app. Try: open "${APP}"`);
    }
  }

  quiet("/usr/bin/osascript", [
    "-e",
    'display notification "You will get one when a session crosses your limit." with title "Context Meter installed" sound name "Glass"',
  ]);

  console.log(`Done.
  Menu bar app : ${APP} (starts at login)
  statusLine   : ${settings.statusLine.command}
  Chained      : ${config.chain ?? "nothing (no previous statusLine)"}
  Thresholds   : context ${config.thresholds.join("%, ")}%, plan ${config.limitThresholds.join("%, ")}% (edit ${CONFIG})
  Backup       : ${existsSync(SETTINGS_BACKUP) ? SETTINGS_BACKUP : "none (no settings.json before)"}`);
}

function uninstall() {
  quiet("/bin/launchctl", ["bootout", `${DOMAIN}/${LABEL}`]);
  rmSync(AGENT, { force: true });
  const settings = readJson(SETTINGS, {});
  if (String(settings.statusLine?.command ?? "").includes(MARKER)) {
    const config = readJson(CONFIG, {});
    if (config.previousStatusLine) settings.statusLine = config.previousStatusLine;
    else delete settings.statusLine;
    writeJson(SETTINGS, settings);
  }
  console.log(`Context Meter uninstalled (statusLine restored, login item removed). Files remain in ${BASE}`);
}

if (process.argv.includes("--uninstall")) uninstall();
else install();
