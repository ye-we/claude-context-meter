// Context Meter: context-window usage across Claude Code sessions, plus the
// account's 5-hour / weekly plan usage, shown in a menu bar item and a small
// always-on-top window. Reads ~/.claude/context-meter/sessions/*.json and
// limits.json, which statusline.mjs writes after each reply.
import AppKit
import Darwin

struct SessionState: Decodable {
    let sessionId: String
    let pct: Double?
    let usedTokens: Int?
    let windowSize: Int?
    let model: String?
    let cwd: String?
    let project: String?
    let updatedAt: Double
    let pid: Int32?
}

struct LimitWindow: Decodable {
    let label: String
    let pct: Double
    let resetsAt: Double?
    let usedUsd: Double?
    let limitUsd: Double?
    let period: String?
}

struct LimitsState: Decodable {
    let updatedAt: Double
    let windows: [String: LimitWindow]
}

struct MeterConfig: Decodable {
    let thresholds: [Double]?
    let limitThresholds: [Double]?
    let staleHours: Double?
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, NSWindowDelegate {
    private let baseDir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".claude/context-meter", isDirectory: true)
    private var sessionsDir: URL { baseDir.appendingPathComponent("sessions", isDirectory: true) }
    private let limitKeys = ["five_hour", "seven_day", "spend_limit"]
    private let rowFont = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    private let panelVisibleKey = "panelVisible"
    private let panelFrameName = "ContextMeterPanel"
    private let rowsStack = NSStackView()
    private var statusItem: NSStatusItem!
    private var panel: NSPanel!
    private var panelSignature = ""
    private var thresholds: [Double] = [70, 85]
    private var limitThresholds: [Double] = [70, 85]
    private var staleHours: Double = 12

    func applicationDidFinishLaunching(_ notification: Notification) {
        UserDefaults.standard.register(defaults: [panelVisibleKey: true])
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.font = .monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.delegate = self
        statusItem.menu = menu
        buildPanel()
        refresh()
        if UserDefaults.standard.bool(forKey: panelVisibleKey) { panel.orderFrontRegardless() }
        let timer = Timer(timeInterval: 2, target: self, selector: #selector(refresh), userInfo: nil, repeats: true)
        timer.tolerance = 0.5
        RunLoop.main.add(timer, forMode: .common)
    }

    // `open ContextMeter.app` while it is running brings the window back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showPanel()
        return false
    }

    func windowWillClose(_ notification: Notification) {
        UserDefaults.standard.set(false, forKey: panelVisibleKey)
    }

    @objc private func refresh() {
        loadConfig()
        let sessions = loadSessions()
        let limits = loadLimits()
        updateButton(sessions, limits: limits)
        updatePanel(sessions, limits: limits)
    }

    // MARK: Data

    private func loadConfig() {
        let url = baseDir.appendingPathComponent("config.json")
        guard let data = try? Data(contentsOf: url),
              let config = try? JSONDecoder().decode(MeterConfig.self, from: data) else { return }
        if let values = config.thresholds, !values.isEmpty { thresholds = values.sorted() }
        if let values = config.limitThresholds, !values.isEmpty {
            limitThresholds = values.sorted()
        } else {
            limitThresholds = thresholds
        }
        if let hours = config.staleHours { staleHours = hours }
    }

    private func isAlive(_ pid: Int32) -> Bool {
        kill(pid, 0) == 0 || errno == EPERM
    }

    // A session is live while its claude process is; sessions with no
    // recorded pid fall back to "updated within staleHours".
    private func loadSessions() -> [SessionState] {
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(at: sessionsDir, includingPropertiesForKeys: nil) else {
            return []
        }
        let now = Date().timeIntervalSince1970 * 1000
        let decoder = JSONDecoder()
        var live: [SessionState] = []
        for file in files where file.pathExtension == "json" {
            guard let data = try? Data(contentsOf: file),
                  let session = try? decoder.decode(SessionState.self, from: data) else { continue }
            let ageHours = (now - session.updatedAt) / 3_600_000
            let alive = session.pid.map { isAlive($0) } ?? (ageHours < staleHours)
            if alive {
                live.append(session)
            } else {
                try? fm.removeItem(at: file)
            }
        }
        return live.sorted { ($0.pct ?? -1) > ($1.pct ?? -1) }
    }

    private func loadLimits() -> LimitsState? {
        guard let data = try? Data(contentsOf: baseDir.appendingPathComponent("limits.json")) else { return nil }
        return try? JSONDecoder().decode(LimitsState.self, from: data)
    }

    // MARK: Formatting

    private func color(_ pct: Double, _ limits: [Double]) -> NSColor? {
        guard let low = limits.first, let high = limits.last else { return nil }
        if pct >= high { return .systemRed }
        if pct >= low { return .systemOrange }
        return nil
    }

    private func glyph(_ pct: Double) -> String {
        switch pct {
        case ..<25: return "○"
        case ..<50: return "◔"
        case ..<75: return "◑"
        case ..<90: return "◕"
        default: return "●"
        }
    }

    private func tokens(_ n: Int) -> String {
        if n >= 1_000_000 {
            return n % 1_000_000 == 0 ? "\(n / 1_000_000)M" : String(format: "%.1fM", Double(n) / 1_000_000)
        }
        return "\(Int((Double(n) / 1000).rounded()))k"
    }

    private func resetText(_ resetsAt: Double, now: Double) -> String {
        let seconds = Int(resetsAt - now)
        if seconds < 86_400 {
            let hours = seconds / 3600
            let minutes = (seconds % 3600) / 60
            return hours > 0 ? "resets in \(hours)h \(minutes)m" : "resets in \(minutes)m"
        }
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate(seconds < 7 * 86_400 ? "EEE jj:mm" : "MMM d")
        return "resets " + formatter.string(from: Date(timeIntervalSince1970: resetsAt))
    }

    private func clockText(_ time: Double) -> String {
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        formatter.dateStyle = .none
        return formatter.string(from: Date(timeIntervalSince1970: time))
    }

    // "███████░░░  72%  details · more details", in the row font.
    private func line(pct: Double?, details: [String], tint: NSColor?, baseColor: NSColor?) -> NSAttributedString {
        var bar = String(repeating: "░", count: 10)
        var pctText = "–"
        if let pct {
            let filled = max(0, min(10, Int((pct / 10).rounded())))
            bar = String(repeating: "█", count: filled) + String(repeating: "░", count: 10 - filled)
            pctText = "\(Int(pct.rounded()))%"
        }
        let paddedPct = String(repeating: " ", count: max(0, 4 - pctText.count)) + pctText
        var attributes: [NSAttributedString.Key: Any] = [.font: rowFont]
        if let baseColor { attributes[.foregroundColor] = baseColor }
        if let tint { attributes[.foregroundColor] = tint }
        return NSAttributedString(string: "\(bar) \(paddedPct)  " + details.joined(separator: " · "), attributes: attributes)
    }

    private func sessionLines(_ sessions: [SessionState], baseColor: NSColor?) -> [NSAttributedString] {
        let names = sessions.map { $0.project ?? "unknown" }
        let repeated = Set(names.filter { name in names.filter { $0 == name }.count > 1 })
        return sessions.map { (session) -> NSAttributedString in
            var name = session.project ?? "unknown"
            if repeated.contains(name) { name += " #" + String(session.sessionId.prefix(6)) }
            var details = [name]
            if let model = session.model { details.append(model) }
            if let used = session.usedTokens, let size = session.windowSize {
                details.append("\(tokens(used))/\(tokens(size))")
            }
            let tint = session.pct.flatMap { color($0, thresholds) }
            return line(pct: session.pct, details: details, tint: tint, baseColor: baseColor)
        }
    }

    // 5-hour, weekly and (behind a gateway) spend windows. A window whose
    // reset time has passed shows no bar until a reply brings fresh numbers.
    private func limitLines(_ limits: LimitsState?, baseColor: NSColor?) -> [NSAttributedString] {
        guard let limits else { return [] }
        let now = Date().timeIntervalSince1970
        return limitKeys.compactMap { (key) -> NSAttributedString? in
            guard let window = limits.windows[key] else { return nil }
            var details = [window.label]
            if let used = window.usedUsd, let cap = window.limitUsd {
                details.append("$\(Int(used.rounded())) of $\(Int(cap.rounded()))" + (window.period.map { " \($0)" } ?? ""))
            }
            if let resetsAt = window.resetsAt, resetsAt <= now {
                details.append("reset at \(clockText(resetsAt)), no reply since")
                return line(pct: nil, details: details, tint: nil, baseColor: baseColor)
            }
            if let resetsAt = window.resetsAt { details.append(resetText(resetsAt, now: now)) }
            return line(pct: window.pct, details: details, tint: color(window.pct, limitThresholds), baseColor: baseColor)
        }
    }

    // MARK: Menu bar item

    private func updateButton(_ sessions: [SessionState], limits: LimitsState?) {
        guard let button = statusItem.button else { return }
        let count = sessions.count
        var tooltip = count == 0
            ? "No active Claude sessions"
            : "\(count) active Claude session\(count == 1 ? "" : "s")"
        let plan = limitKeys.compactMap { key in limits?.windows[key].map { "\($0.label) \(Int($0.pct.rounded()))%" } }
        if !plan.isEmpty { tooltip += "\n" + plan.joined(separator: " · ") }
        button.toolTip = tooltip

        guard let top = sessions.first(where: { $0.pct != nil }), let pct = top.pct else {
            button.title = count == 0 ? "◌ –" : "◌ …"
            return
        }
        let text = "\(glyph(pct)) \(Int(pct.rounded()))%"
        if let tint = color(pct, thresholds) {
            let font = button.font ?? NSFont.menuBarFont(ofSize: 0)
            button.attributedTitle = NSAttributedString(string: text, attributes: [.foregroundColor: tint, .font: font])
        } else {
            button.title = text
        }
    }

    // MARK: Floating window

    private func buildPanel() {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 320, height: 40),
            styleMask: [.titled, .closable, .utilityWindow, .hudWindow, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.title = "Claude context"
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.isMovableByWindowBackground = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.delegate = self

        rowsStack.orientation = .vertical
        rowsStack.alignment = .leading
        rowsStack.spacing = 4
        rowsStack.edgeInsets = NSEdgeInsets(top: 8, left: 12, bottom: 10, right: 12)
        let content = NSView()
        content.addSubview(rowsStack)
        panel.contentView = content

        if !panel.setFrameUsingName(panelFrameName), let screen = NSScreen.main {
            let area = screen.visibleFrame
            panel.setFrameTopLeftPoint(NSPoint(x: area.maxX - 440, y: area.maxY - 12))
        }
        panel.setFrameAutosaveName(panelFrameName)
        self.panel = panel
    }

    // Rebuilds the rows only when their text changes; keeps the window's
    // top-left corner fixed as it grows or shrinks.
    private func updatePanel(_ sessions: [SessionState], limits: LimitsState?) {
        let planLines = limitLines(limits, baseColor: .labelColor)
        let rows: [NSAttributedString] = sessions.isEmpty
            ? [NSAttributedString(
                string: "No active Claude sessions",
                attributes: [.font: rowFont, .foregroundColor: NSColor.secondaryLabelColor]
            )]
            : sessionLines(sessions, baseColor: .labelColor)
        let signature = "\(thresholds)\(limitThresholds)\n"
            + (planLines + rows).map(\.string).joined(separator: "\n")
        guard signature != panelSignature else { return }
        panelSignature = signature

        rowsStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for text in planLines {
            rowsStack.addArrangedSubview(NSTextField(labelWithAttributedString: text))
        }
        if let lastPlanLine = rowsStack.arrangedSubviews.last {
            rowsStack.setCustomSpacing(12, after: lastPlanLine)
        }
        for text in rows {
            rowsStack.addArrangedSubview(NSTextField(labelWithAttributedString: text))
        }
        let size = rowsStack.fittingSize
        let topLeft = NSPoint(x: panel.frame.minX, y: panel.frame.maxY)
        rowsStack.frame = NSRect(origin: .zero, size: size)
        panel.setContentSize(size)
        panel.setFrameTopLeftPoint(topLeft)
    }

    private func showPanel() {
        UserDefaults.standard.set(true, forKey: panelVisibleKey)
        panel.orderFrontRegardless()
    }

    @objc private func togglePanel() {
        if panel.isVisible { panel.close() } else { showPanel() }
    }

    // MARK: Dropdown menu

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let planLines = limitLines(loadLimits(), baseColor: nil)
        if !planLines.isEmpty {
            menu.addItem(.sectionHeader(title: "Plan usage"))
            for text in planLines {
                let item = disabledItem(text.string)
                item.attributedTitle = text
                menu.addItem(item)
            }
            menu.addItem(.sectionHeader(title: "Sessions"))
        }

        let sessions = loadSessions()
        if sessions.isEmpty {
            menu.addItem(disabledItem("No active Claude sessions"))
        } else {
            for (session, text) in zip(sessions, sessionLines(sessions, baseColor: nil)) {
                let item = NSMenuItem(title: text.string, action: #selector(copySessionId(_:)), keyEquivalent: "")
                item.attributedTitle = text
                item.target = self
                item.representedObject = session.sessionId
                item.toolTip = (session.cwd ?? "") + "\nClick to copy the session id"
                menu.addItem(item)
            }
        }

        menu.addItem(.separator())
        let context = thresholds.map { "\(Int($0))%" }.joined(separator: " · ")
        let plan = limitThresholds.map { "\(Int($0))%" }.joined(separator: " · ")
        menu.addItem(disabledItem("Notifies at \(context) context, \(plan) plan (config.json)"))
        menu.addItem(actionItem(panel.isVisible ? "Hide Floating Window" : "Show Floating Window", #selector(togglePanel)))
        menu.addItem(actionItem("Open Context Meter Folder", #selector(openFolder)))
        menu.addItem(actionItem("Quit Context Meter", #selector(quit), key: "q"))
    }

    private func disabledItem(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    private func actionItem(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    @objc private func copySessionId(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(id, forType: .string)
    }

    @objc private func openFolder() {
        NSWorkspace.shared.open(baseDir)
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    withExtendedLifetime(delegate) { app.run() }
}
