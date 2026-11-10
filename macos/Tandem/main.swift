// Tandem for Mac: a native window around the Tandem web app, plus a menu-bar icon.
// It runs the Tandem server (bundled with its own Node) in the background, so Bots
// keep working when the window is closed. Quit from the menu bar stops everything.
import AppKit
import WebKit
import UserNotifications
import ServiceManagement
import Carbon.HIToolbox

let ENV = ProcessInfo.processInfo.environment
let PORT = Int(ENV["TANDEM_PORT"] ?? "") ?? 4747
let HOME = FileManager.default.homeDirectoryForCurrentUser
let APP_URL = URL(string: "http://127.0.0.1:\(PORT)/?app=mac")!

// MARK: - Server process

final class Server {
    var process: Process?
    var stopping = false
    var restarts = 0
    let logURL: URL

    init() {
        let dir = Server.dataDir()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        logURL = dir.appendingPathComponent("tandem.log")
    }

    // Keep using ~/tandem/data if Tandem was installed from the command line before.
    static func dataDir() -> URL {
        if let d = ENV["TANDEM_DATA"], !d.isEmpty { return URL(fileURLWithPath: d) }
        let legacy = HOME.appendingPathComponent("tandem/data")
        if FileManager.default.fileExists(atPath: legacy.appendingPathComponent("tandem.db").path) { return legacy }
        return HOME.appendingPathComponent("Library/Application Support/Tandem")
    }

    var resources: URL { Bundle.main.resourceURL! }

    func isUp(_ done: @escaping (Bool) -> Void) {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(PORT)/api/plan")!)
        req.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            done((resp as? HTTPURLResponse)?.statusCode == 200)
        }.resume()
    }

    var watchdog: Timer?
    var onRestarted: (() -> Void)?

    func start() {
        isUp { up in
            // Another Tandem (Terminal or login item) is already serving: just use it.
            if !up { DispatchQueue.main.async { self.launch() } }
        }
        // If that other Tandem stops, or ours crashes, take over so Bots keep working.
        watchdog = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in
            guard let self, !self.stopping else { return }
            if self.process?.isRunning == true { return }
            self.isUp { up in
                if up { return }
                DispatchQueue.main.async {
                    guard self.process?.isRunning != true else { return }
                    self.restarts = 0
                    self.launch()
                    self.onRestarted?()
                }
            }
        }
    }

    private func launch() {
        let node = resources.appendingPathComponent("node/bin/node")
        let entry = resources.appendingPathComponent("tandem/server/index.js")
        let p = Process()
        p.executableURL = node
        p.arguments = [entry.path]
        p.currentDirectoryURL = resources.appendingPathComponent("tandem")
        var env = ProcessInfo.processInfo.environment
        // Apps launched from Finder get a bare PATH; Claude Code and Homebrew live elsewhere.
        let extra = ["\(HOME.path)/.local/bin", "\(HOME.path)/.claude/local", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin",
                     resources.appendingPathComponent("node/bin").path]
        env["PATH"] = (extra + [env["PATH"] ?? ""]).joined(separator: ":")
        env["TANDEM_DATA"] = Server.dataDir().path
        env["PORT"] = String(PORT)
        env["TANDEM_APP"] = "mac"
        p.environment = env
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        if let log = try? FileHandle(forWritingTo: logURL) {
            log.seekToEndOfFile()
            p.standardOutput = log
            p.standardError = log
        }
        p.terminationHandler = { [weak self] _ in
            guard let self, !self.stopping else { return }
            self.restarts += 1
            if self.restarts < 5 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.launch() }
            }
        }
        do { try p.run(); process = p } catch { NSLog("Tandem server failed: \(error)") }
    }

    func stop() {
        stopping = true
        process?.terminate()
    }
}

// MARK: - Window

final class WindowController: NSWindowController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, NSWindowDelegate {
    var web: WKWebView!
    var loadingView: NSView!
    var retryTimer: Timer?
    var onMessage: ((String, [String: Any]) -> Void)?

    convenience init() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1240, height: 820),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                              backing: .buffered, defer: false)
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = false
        window.minSize = NSSize(width: 760, height: 520)
        window.setFrameAutosaveName("TandemMain")
        if window.frame.origin == .zero { window.center() }
        window.title = "Tandem"
        self.init(window: window)
        window.delegate = self

        // Real macOS translucency behind the sidebar; the page draws everything else.
        let effect = NSVisualEffectView()
        effect.material = .sidebar
        effect.blendingMode = .behindWindow
        effect.state = .followsWindowActiveState
        window.contentView = effect

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        config.userContentController.add(self, name: "tandem")
        config.mediaTypesRequiringUserActionForPlayback = []
        web = WKWebView(frame: effect.bounds, configuration: config)
        web.autoresizingMask = [.width, .height]
        web.setValue(false, forKey: "drawsBackground")
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsMagnification = true
        web.customUserAgent = nil
        effect.addSubview(web)

        // A calm splash while the server starts.
        loadingView = NSView(frame: effect.bounds)
        loadingView.autoresizingMask = [.width, .height]
        loadingView.wantsLayer = true
        loadingView.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        let icon = NSImageView(image: NSApp.applicationIconImage)
        icon.frame = NSRect(x: 0, y: 0, width: 96, height: 96)
        icon.autoresizingMask = [.minXMargin, .maxXMargin, .minYMargin, .maxYMargin]
        let label = NSTextField(labelWithString: "Starting Tandem")
        label.font = .systemFont(ofSize: 13, weight: .medium)
        label.textColor = .secondaryLabelColor
        label.alignment = .center
        label.autoresizingMask = [.minXMargin, .maxXMargin, .minYMargin, .maxYMargin]
        loadingView.addSubview(icon)
        loadingView.addSubview(label)
        effect.addSubview(loadingView)
        let center = { [weak self] in
            guard let self else { return }
            let b = self.loadingView.bounds
            icon.frame.origin = NSPoint(x: b.midX - 48, y: b.midY - 20)
            label.frame = NSRect(x: b.midX - 120, y: b.midY - 56, width: 240, height: 20)
        }
        center()
        NotificationCenter.default.addObserver(forName: NSView.frameDidChangeNotification, object: loadingView, queue: .main) { _ in center() }
        loadingView.postsFrameChangedNotifications = true

        _ = mouseMonitor
        load()
    }

    func load() {
        web.load(URLRequest(url: APP_URL))
    }

    // Retry until the server is up.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        retryTimer?.invalidate()
        retryTimer = Timer.scheduledTimer(withTimeInterval: 0.6, repeats: false) { [weak self] _ in self?.load() }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.25
            loadingView.animator().alphaValue = 0
        } completionHandler: { self.loadingView.isHidden = true }
    }

    // Links to other sites open in the default browser.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, url.host != "127.0.0.1", url.host != "localhost", url.scheme?.hasPrefix("http") == true {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        if action.targetFrame == nil, let url = action.request.url { NSWorkspace.shared.open(url); return decisionHandler(.cancel) }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if url.host == "127.0.0.1" && url.path == "/files" { NSWorkspace.shared.open(url) } else { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    // File pickers for attachments and avatars.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.beginSheetModal(for: window!) { r in completionHandler(r == .OK ? panel.urls : nil) }
    }

    // Microphone for voice chat and dictation.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == "127.0.0.1" ? .grant : .deny)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        a.beginSheetModal(for: window!) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    var lastMouseDown: NSEvent?
    lazy var mouseMonitor: Any? = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] e in self?.lastMouseDown = e; return e }

    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        // Empty areas of the page's top bars move and zoom the window, like a title bar.
        if type == "drag", let e = lastMouseDown, NSEvent.pressedMouseButtons & 1 == 1 { window?.performDrag(with: e); return }
        if type == "zoom" { window?.zoom(nil); return }
        onMessage?(type, body)
    }

    func run(_ js: String) { web.evaluateJavaScript(js, completionHandler: nil) }

    // Closing the window keeps Tandem running in the menu bar.
    func windowShouldClose(_ sender: NSWindow) -> Bool { sender.orderOut(nil); return false }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate, NSMenuDelegate {
    let server = Server()
    var wc: WindowController!
    var status: NSStatusItem!
    var working: [[String: Any]] = []
    var pending = 0

    func applicationDidFinishLaunching(_ n: Notification) {
        buildMainMenu()
        server.start()
        wc = WindowController()
        server.onRestarted = { [weak self] in DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { self?.wc.load() } }
        wc.onMessage = { [weak self] type, body in self?.handle(type, body) }
        wc.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)

        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        status.button?.image = AppDelegate.menuBarIcon()
        status.button?.toolTip = "Tandem"
        let menu = NSMenu()
        menu.delegate = self
        status.menu = menu

        registerQuickAskHotKey()
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool { show(); return true }
    func applicationWillTerminate(_ n: Notification) { server.stop() }

    func show(hash: String? = nil) {
        wc.showWindow(nil)
        wc.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if let hash { wc.run("location.hash = '\(hash)'") }
    }

    // Messages from the page: notifications, working Bots, items waiting for you.
    func handle(_ type: String, _ body: [String: Any]) {
        switch type {
        case "notify":
            let c = UNMutableNotificationContent()
            c.title = body["title"] as? String ?? "Tandem"
            c.body = body["body"] as? String ?? ""
            c.sound = .default
            if let chat = body["chatId"] as? String { c.userInfo = ["hash": "#/chat/\(chat)"] }
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
        case "status":
            working = body["working"] as? [[String: Any]] ?? []
            pending = body["pending"] as? Int ?? 0
            NSApp.dockTile.badgeLabel = pending > 0 ? String(pending) : nil
            status.button?.appearsDisabled = false
            status.button?.image = AppDelegate.menuBarIcon(active: !working.isEmpty)
        default: break
        }
    }

    func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
        show(hash: r.notification.request.content.userInfo["hash"] as? String)
        done()
    }
    func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done(NSApp.isActive && wc.window?.isKeyWindow == true ? [] : [.banner, .sound])
    }

    // Menu-bar menu, rebuilt each time it opens.
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        menu.addItem(withTitle: "Open Tandem", action: #selector(openApp), keyEquivalent: "").target = self
        menu.addItem(.separator())
        if working.isEmpty {
            let i = NSMenuItem(title: "No Bots working", action: nil, keyEquivalent: ""); i.isEnabled = false; menu.addItem(i)
        } else {
            let h = NSMenuItem(title: "Working now", action: nil, keyEquivalent: ""); h.isEnabled = false; menu.addItem(h)
            for w in working.prefix(8) {
                let name = w["name"] as? String ?? "Bot", st = w["status"] as? String ?? ""
                let i = NSMenuItem(title: "\(name): \(st)", action: #selector(openChat(_:)), keyEquivalent: "")
                i.representedObject = w["chatId"]; i.target = self; menu.addItem(i)
            }
        }
        if pending > 0 {
            menu.addItem(.separator())
            let i = NSMenuItem(title: "\(pending) waiting for you", action: #selector(openHome), keyEquivalent: ""); i.target = self; menu.addItem(i)
        }
        menu.addItem(.separator())
        let qa = NSMenuItem(title: "Quick Ask", action: #selector(quickAsk), keyEquivalent: " ")
        qa.keyEquivalentModifierMask = [.option]; qa.target = self; menu.addItem(qa)
        menu.addItem(withTitle: "New Bot", action: #selector(newBot), keyEquivalent: "").target = self
        let login = NSMenuItem(title: "Open at Login", action: #selector(toggleLogin), keyEquivalent: "")
        login.target = self
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        menu.addItem(login)
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Tandem", action: #selector(quit), keyEquivalent: "q").target = self
    }

    @objc func openApp() { show() }
    @objc func openHome() { show(hash: "#/home") }
    @objc func openChat(_ s: NSMenuItem) { show(hash: (s.representedObject as? String).map { "#/chat/\($0)" }) }
    @objc func newBot() { show(); wc.run("window.tandemNewBot && window.tandemNewBot()") }
    @objc func toggleLogin() {
        do { if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() } else { try SMAppService.mainApp.register() } }
        catch { let a = NSAlert(); a.messageText = "Couldn't change Open at Login"; a.informativeText = error.localizedDescription; a.runModal() }
    }
    @objc func quit() {
        let a = NSAlert()
        a.messageText = "Quit Tandem?"
        a.informativeText = "Your Bots stop working and routines won't run until you open Tandem again. To keep them going, close the window instead."
        a.addButton(withTitle: "Quit"); a.addButton(withTitle: "Cancel")
        if working.isEmpty || a.runModal() == .alertFirstButtonReturn { NSApp.terminate(nil) }
    }

    func buildMainMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let app = NSMenu()
        app.addItem(withTitle: "About Tandem", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Settings…", action: #selector(openSettings), keyEquivalent: ",").target = self
        app.addItem(.separator())
        app.addItem(withTitle: "Hide Tandem", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "Quit Tandem", action: #selector(quit), keyEquivalent: "q").target = self
        appItem.submenu = app
        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        let winItem = NSMenuItem(); main.addItem(winItem)
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        win.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r").target = self
        winItem.submenu = win
        NSApp.mainMenu = main
        NSApp.windowsMenu = win
    }
    @objc func openSettings() { show(hash: "#/settings") }

    // ⌥Space anywhere on the Mac opens Quick Ask. Carbon hot keys need no extra permission.
    var hotKeyRef: EventHotKeyRef?
    func registerQuickAskHotKey() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ -> OSStatus in
            DispatchQueue.main.async { (NSApp.delegate as? AppDelegate)?.quickAsk() }
            return noErr
        }, 1, &spec, nil, nil)
        let id = EventHotKeyID(signature: OSType(0x54444D51), id: 1) // 'TDMQ'
        let status = RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey), id, GetApplicationEventTarget(), 0, &hotKeyRef)
        if status != noErr { NSLog("Quick Ask hot key ⌥Space is taken by another app") }
    }
    @objc func quickAsk() {
        show()
        wc.run("window.tandemQuickAsk && window.tandemQuickAsk()")
    }
    @objc func reload() { wc.load() }

    // Two linked rings, drawn as a template image so it fits light and dark menu bars.
    static func menuBarIcon(active: Bool = false) -> NSImage {
        let img = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { r in
            let lw: CGFloat = 1.8
            NSColor.black.setStroke()
            let a = NSBezierPath(ovalIn: NSRect(x: 1.5, y: 4, width: 9.5, height: 9.5)); a.lineWidth = lw; a.stroke()
            let b = NSBezierPath(ovalIn: NSRect(x: 7, y: 4, width: 9.5, height: 9.5)); b.lineWidth = lw; b.stroke()
            if active { NSColor.black.setFill(); NSBezierPath(ovalIn: NSRect(x: 14, y: 13, width: 4, height: 4)).fill() }
            return true
        }
        img.isTemplate = true
        return img
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
