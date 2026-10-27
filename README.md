# Claude Context Meter

A macOS menu bar app that shows how full the context window is in every Claude Code session running on your Mac. It also shows your 5-hour and weekly plan usage, and sends a notification when a session or a plan window crosses a threshold.

```
Plan usage
█████░░░░░  48%  5-hour · resets in 1h 17m
█████░░░░░  51%  Weekly · resets Wed 10:00

Sessions
████████░░  82%  api-server · Opus 5.5 · 824k/1M
███████░░░  69%  docs-site · Opus 5.5 · 694k/1M
█████░░░░░  46%  billing #cee9e5 · Opus 5.5 · 463k/1M
█████░░░░░  45%  billing #454007 · Opus 5.5 · 451k/1M
```

The menu bar shows the fullest session, e.g. `◕ 82%`. Rows turn orange at the first threshold and red at the last. A small always-on-top window shows the same rows.

## How it works

After every reply, Claude Code sends a JSON description of the session to the [status line command](https://code.claude.com/docs/en/statusline): context window usage, model, working directory and, when available, `rate_limits`. The installer makes `statusline.mjs` that command. On each run it:

- writes one small file per session to `~/.claude/context-meter/sessions/`, containing the context %, tokens, model, project and the claude process id;
- writes your plan usage to `~/.claude/context-meter/limits.json`;
- sends a macOS notification the first time a session or plan window crosses a threshold;
- prints your previous status line if you had one, or a short default (`Opus 5.5 · my-project · ctx 42% (84k/200k)`).

The menu bar app reads those files every 2 seconds. A session disappears when its claude process exits.

There are no network calls, no transcript parsing, and no dependencies beyond Node and the Swift compiler.

## Requirements

- macOS 14 or later
- Node 18 or later
- Xcode Command Line Tools, for `swiftc` (`xcode-select --install`)
- A Claude Code version whose status line JSON includes `context_window`

## Install

```sh
git clone https://github.com/ye-we/claude-context-meter.git
node claude-context-meter/install.mjs
```

The installer:

1. copies the three source files to `~/.claude/context-meter/` and builds `ContextMeter.app` there with `swiftc`;
2. sets `statusLine` in `~/.claude/settings.json` to `statusline.mjs`. If you already had a status line, it keeps running and its output is still what you see. Your original `settings.json` is backed up once, to `settings.json.context-meter-backup`;
3. adds a LaunchAgent (`~/Library/LaunchAgents/local.context-meter.plist`) so the app starts at login, then starts it;
4. sends a test notification.

Running it again is safe, and is how you update after a `git pull`. Open sessions switch to the new status line on their own.

## Configuration

`~/.claude/context-meter/config.json`:

| Key | Default | Meaning |
| --- | --- | --- |
| `thresholds` | `[70, 85]` | Context % that triggers a notification (orange at the first value, red at the last) |
| `limitThresholds` | `[70, 85]` | The same for 5-hour and weekly plan usage |
| `staleHours` | `12` | How long to keep showing a session whose claude process couldn't be identified |

Changes take effect on the next refresh, with no restart needed.

## Menu bar icon hidden behind the notch?

macOS puts new menu bar icons furthest left and hides them when the bar is full. To move it next to the clock:

```sh
defaults write local.context-meter "NSStatusItem Preferred Position Item-0" -float 150
launchctl kickstart -k gui/$(id -u)/local.context-meter
```

Apple doesn't document this preference, but it worked on macOS 26. You can also show the floating window from the menu, or run `open ~/.claude/context-meter/ContextMeter.app` to bring it back.

## Notifications

Notifications are sent with `osascript`. If the test notification doesn't appear, check Script Editor in System Settings → Notifications.

## Limitations

- It covers Claude Code CLI sessions on this Mac, in any terminal. claude.ai and remote sessions aren't included.
- A project with its own `statusLine` in `.claude/settings.json` or `.claude/settings.local.json` overrides yours, so sessions in that project won't report.
- Numbers update when a session gets a reply. Plan usage only appears when Claude Code sends `rate_limits`, and not every account does.
- Claude Code runs one status line command per session, so the installer takes over that setting and calls your existing command from inside it.

## Uninstall

```sh
node ~/.claude/context-meter/install.mjs --uninstall
```

This restores your previous `statusLine` and removes the LaunchAgent. Delete `~/.claude/context-meter` to remove the rest.

## License

MIT
