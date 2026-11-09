import AppKit
import Darwin
import Foundation
import UniformTypeIdentifiers
import WebKit

final class CloneAIDesktop: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, NSToolbarDelegate {
    private static let showWindowNotification = Notification.Name("ai.clone.desktop.show-window")
    private var window: NSWindow!
    private var webView: WKWebView!
    private var navigationControl: NSSegmentedControl!
    private let navigationItemIdentifier = NSToolbarItem.Identifier("CloneAINavigation")
    private let navigationTitles = ["对话", "定时任务", "Agent", "记忆", "设置"]
    private var startupView: NSView!
    private var startupTitle: NSTextField!
    private var startupDetail: NSTextField!
    private var startupDot: NSView!
    private var startupDotTimer: Timer?
    private var daemon: Process?
    private var stdoutBuffer = ""
    private var stderrBuffer = ""
    private var localURL: URL?
    private var shuttingDown = false
    private var readyTimer: Timer?
    private var signalSources: [DispatchSourceSignal] = []
    private var selectedNavigationIndex = 0
    private var pendingNavigationIndex: Int?
    private var pageReady = false
    private var developerRoot: URL?
    private var developerRestartPending = false
    private var developerReloadMarker: URL?
    private var developerReloadStamp: Date?
    private var developerReloadTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let configuredRoot = ProcessInfo.processInfo.environment["CLONE_AI_DEV_ROOT"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !configuredRoot.isEmpty {
            developerRoot = URL(fileURLWithPath: configuredRoot, isDirectory: true).standardizedFileURL
        }
        if activateExistingInstance() {
            DistributedNotificationCenter.default().post(name: Self.showWindowNotification, object: nil)
            NSApp.terminate(nil)
            return
        }
        DistributedNotificationCenter.default().addObserver(
            self,
            selector: #selector(showExistingWindow(_:)),
            name: Self.showWindowNotification,
            object: nil
        )
        installSignalHandlers()
        installDeveloperReloadWatcher()
        installMenu()
        let webConfiguration = WKWebViewConfiguration()
        webConfiguration.userContentController.add(self, name: "cloneNavigation")
        webConfiguration.userContentController.add(self, name: "cloneFolderPicker")
        webConfiguration.userContentController.addUserScript(WKUserScript(
            source: """
            window.CloneNative = {
              available: true,
              chooseDirectory: (purpose = "workspace") => window.webkit.messageHandlers.cloneFolderPicker.postMessage({
                action: "chooseDirectory",
                purpose: purpose
              }),
              revealInFinder: (path) => window.webkit.messageHandlers.cloneFolderPicker.postMessage({
                action: "reveal",
                path: path
              }),
              openURL: (url) => window.webkit.messageHandlers.cloneFolderPicker.postMessage({
                action: "openURL",
                url: url
              })
            };
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        webView = WKWebView(frame: .zero, configuration: webConfiguration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1240, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = developerRoot == nil ? "Clone AI" : "Clone AI · Dev"
        window.minSize = NSSize(width: 720, height: 520)
        window.isReleasedWhenClosed = false
        startupView = makeStartupView()
        window.contentView = startupView
        window.center()
        installToolbar()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        showMessage(title: "正在启动 Clone AI", detail: "正在启动本地运行时，请稍候。")
        startDaemon()
    }

    private func activateExistingInstance() -> Bool {
        let currentPID = ProcessInfo.processInfo.processIdentifier
        let currentBundle = Bundle.main.bundleURL.standardizedFileURL
        let existing = NSWorkspace.shared.runningApplications.first { application in
            guard application.processIdentifier != currentPID,
                  !application.isTerminated else { return false }
            if let identifier = Bundle.main.bundleIdentifier,
               application.bundleIdentifier == identifier {
                return true
            }
            return application.bundleURL?.standardizedFileURL == currentBundle
        }
        guard let existing else { return false }
        existing.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
        return true
    }

    @objc private func showExistingWindow(_ notification: Notification) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.window != nil else { return }
            if !self.window.isVisible {
                self.window.makeKeyAndOrderFront(nil)
            }
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    // Closing the window hides the work surface, not the local runtime. The
    // owner explicitly quits from the Dock menu when they want to stop it.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            window.makeKeyAndOrderFront(nil)
        }
        NSApp.activate(ignoringOtherApps: true)
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let process = daemon, process.isRunning else { return .terminateNow }
        if shuttingDown { return .terminateNow }
        shuttingDown = true
        window.title = "Clone AI - 正在安全关闭"
        process.terminate()
        let graceDeadline = Date().addingTimeInterval(8)
        while process.isRunning && Date() < graceDeadline {
            Thread.sleep(forTimeInterval: 0.1)
        }
        if process.isRunning {
            process.interrupt()
            let interruptDeadline = Date().addingTimeInterval(2)
            while process.isRunning && Date() < interruptDeadline {
                Thread.sleep(forTimeInterval: 0.1)
            }
        }
        if process.isRunning {
            Darwin.kill(process.processIdentifier, SIGKILL)
        }
        process.waitUntilExit()
        return .terminateNow
    }

    private func installToolbar() {
        navigationControl = NSSegmentedControl(
            labels: navigationTitles,
            trackingMode: .selectOne,
            target: self,
            action: #selector(navigateFromToolbar(_:))
        )
        navigationControl.segmentStyle = .rounded
        navigationControl.controlSize = .large
        navigationControl.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        let widths: [CGFloat] = [68, 92, 78, 68, 68]
        for (index, width) in widths.enumerated() {
            navigationControl.setWidth(width, forSegment: index)
        }
        navigationControl.selectedSegment = selectedNavigationIndex

        let toolbar = NSToolbar(identifier: "CloneAIMainToolbar")
        toolbar.delegate = self
        toolbar.displayMode = .iconOnly
        toolbar.allowsUserCustomization = false
        toolbar.autosavesConfiguration = false
        window.toolbarStyle = .unified
        window.titleVisibility = .hidden
        window.toolbar = toolbar
    }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.flexibleSpace, navigationItemIdentifier, .flexibleSpace]
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.flexibleSpace, navigationItemIdentifier]
    }

    func toolbar(
        _ toolbar: NSToolbar,
        itemForItemIdentifier itemIdentifier: NSToolbarItem.Identifier,
        willBeInsertedIntoToolbar flag: Bool
    ) -> NSToolbarItem? {
        guard itemIdentifier == navigationItemIdentifier else { return nil }
        let item = NSToolbarItem(itemIdentifier: itemIdentifier)
        item.view = navigationControl
        item.label = "导航"
        item.paletteLabel = "主导航"
        item.toolTip = "在对话、定时任务、Agent、记忆和设置之间切换"
        item.visibilityPriority = .high
        return item
    }

    @objc private func navigateFromToolbar(_ sender: NSSegmentedControl) {
        navigate(to: sender.selectedSegment)
    }

    @objc private func navigateFromMenu(_ sender: NSMenuItem) {
        navigate(to: sender.tag)
    }

    @objc private func newTaskFromMenu(_ sender: NSMenuItem) {
        // A pending new-task composition must not be replaced by a stale
        // navigation callback from an earlier request.
        // 正在新建任务时，旧请求里迟到的导航回调不能把它替换掉。
        selectedNavigationIndex = 0
        navigationControl?.selectedSegment = 0
        guard pageReady else {
            pendingNavigationIndex = 0
            return
        }
        webView.evaluateJavaScript("window.closeSchedules?.(); window.closeSettings?.(); document.getElementById('new-session')?.click();")
    }

    @objc private func openSchedulesFromMenu(_ sender: NSMenuItem) {
        navigate(to: 1)
    }

    @objc private func showSettingsFromMenu(_ sender: NSMenuItem) {
        navigate(to: 4)
    }

    private func navigate(to index: Int) {
        guard navigationTitles.indices.contains(index) else { return }
        selectedNavigationIndex = index
        navigationControl?.selectedSegment = index
        guard pageReady else {
            pendingNavigationIndex = index
            return
        }
        executeNavigation(index: index)
    }

    private func executeNavigation(index: Int) {
        let script: String
        switch index {
        case 1:
            script = "window.closeSettings?.(); window.openSchedules?.();"
        case 2:
            script = "window.closeSchedules?.(); window.openSettings?.(); window.selectSettingsSection?.('agents');"
        case 3:
            script = "window.closeSchedules?.(); window.openSettings?.(); window.selectSettingsSection?.('memory');"
        case 4:
            script = "window.closeSchedules?.(); window.openSettings?.(); window.selectSettingsSection?.('situation');"
        default:
            script = "window.closeSchedules?.(); window.closeSettings?.(); window.setSidebarOpen?.(false); setTimeout(() => document.getElementById('query')?.focus(), 40);"
        }
        webView.evaluateJavaScript(script)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "cloneFolderPicker" {
            handleFolderPickerMessage(message)
            return
        }
        guard message.name == "cloneNavigation", let section = message.body as? String else { return }
        if section == "ready" {
            pageReady = true
            var targetIndex = selectedNavigationIndex
            let previewPrefix = "--preview-section="
            if let argument = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix(previewPrefix) }) {
                let previewSection = String(argument.dropFirst(previewPrefix.count))
                let index = ["schedules", "agents", "memory", "settings"].firstIndex(of: previewSection).map { $0 + 1 } ?? 0
                selectedNavigationIndex = index
                navigationControl?.selectedSegment = index
                targetIndex = index
            }
            if let pending = pendingNavigationIndex {
                pendingNavigationIndex = nil
                targetIndex = pending
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
                self?.executeNavigation(index: targetIndex)
            }
            if ProcessInfo.processInfo.arguments.contains("--preview-mobile-binding") {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { [weak self] in
                    self?.webView.evaluateJavaScript("window.openMobileBinding?.();")
                }
            }
            return
        }
        let index: Int
        switch section {
        case "schedules": index = 1
        case "agents": index = 2
        case "memory": index = 3
        case "settings": index = 4
        default: index = 0
        }
        selectedNavigationIndex = index
        navigationControl?.selectedSegment = index
    }

    private func handleFolderPickerMessage(_ message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }
        if action == "reveal", let path = body["path"] as? String, !path.isEmpty {
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
            return
        }
        if action == "openURL",
           let raw = body["url"] as? String,
           let url = URL(string: raw),
           url.scheme == "https" || url.scheme == "http" {
            NSWorkspace.shared.open(url)
            return
        }
        guard action == "chooseDirectory" else { return }
        let purpose = (body["purpose"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "workspace"
        chooseDirectory(purpose: purpose)
    }

    private func chooseDirectory(purpose: String) {
        let panel = NSOpenPanel()
        if purpose == "connector" {
            panel.title = "选择观察目录"
            panel.message = "分身只会读取这个目录，不会获得执行权限。"
        } else {
            panel.title = "选择工作目录"
            panel.message = "Clone AI 会在这个目录中读取和写入任务产物。"
        }
        panel.prompt = "选择"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.resolvesAliases = true
        panel.beginSheetModal(for: window) { [weak self] response in
            guard let self else { return }
            guard response == .OK, let url = panel.url else {
                self.webView.evaluateJavaScript("window.CloneNative?.onDirectoryCancelled?.();")
                return
            }
            let purposeLiteral = self.javaScriptStringLiteral(purpose)
            let pathLiteral = self.javaScriptStringLiteral(url.path)
            self.webView.evaluateJavaScript(
                "window.CloneNative?.onDirectoryChosen?.(\(purposeLiteral), \(pathLiteral));"
            )
        }
    }

    private func javaScriptStringLiteral(_ value: String) -> String {
        guard let data = try? JSONEncoder().encode(value),
              let encoded = String(data: data, encoding: .utf8) else { return "\"\"" }
        return encoded
    }

    // WKWebView only raises a real file chooser when the UI delegate answers
    // this callback; without it the composer's attach button silently does
    // nothing. 只有实现这个 UI 委托回调，WKWebView 才会弹出真正的文件选择面板；
    // 缺失时输入框的附件按钮会毫无反应。
    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.title = "添加图片或视频"
        panel.message = "选择要发送给 Clone AI 的图片或视频。"
        panel.prompt = "添加"
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.resolvesAliases = true
        panel.allowedContentTypes = [.image, .movie]
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, !panel.urls.isEmpty else {
                completionHandler(nil)
                return
            }
            completionHandler(panel.urls)
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        pageReady = false
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "about" {
            decisionHandler(.allow)
            return
        }
        let allowed = localURL != nil && url.scheme == "http"
            && url.host == "127.0.0.1" && url.port == localURL?.port
        decisionHandler(allowed ? .allow : .cancel)
    }

    // Development mode reloads the process boundary in place: source edits
    // restart the sidecar, then the existing WebView navigates to the new port.
    // 开发模式原地重载进程边界：源码变化会重启 sidecar，现有 WebView 再跳到新端口。
    private func reloadDeveloperRuntime() {
        guard developerRoot != nil, !shuttingDown, !developerRestartPending else { return }
        readyTimer?.invalidate()
        readyTimer = nil
        localURL = nil
        pageReady = false
        guard let process = daemon, process.isRunning else {
            daemon = nil
            startDaemon()
            return
        }
        developerRestartPending = true
        process.terminate()
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            if self.developerRestartPending && process.isRunning {
                process.interrupt()
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
            if self.developerRestartPending && process.isRunning {
                Darwin.kill(process.processIdentifier, SIGKILL)
            }
        }
    }

    /**
     * The development driver writes a marker instead of sending a signal.
     * Signals can kill a stale app binary before it registers a handler; a
     * modification timestamp is observable even when the shell itself is old.
     *
     * 开发驱动写一个标记文件，而不是发送信号。旧 App 二进制若尚未注册信号处理器会被
     * 直接杀死；修改时间则连旧壳也能观测到。
     */
    private func installDeveloperReloadWatcher() {
        guard developerRoot != nil,
              let configured = ProcessInfo.processInfo.environment["CLONE_AI_DEV_RELOAD_FILE"]?.trimmingCharacters(in: .whitespacesAndNewlines),
              !configured.isEmpty else { return }
        let marker = URL(fileURLWithPath: configured)
        developerReloadMarker = marker
        developerReloadStamp = modificationDate(of: marker)
        developerReloadTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] _ in
            guard let self, let marker = self.developerReloadMarker else { return }
            guard let stamp = self.modificationDate(of: marker) else { return }
            if let previous = self.developerReloadStamp {
                if stamp > previous {
                    self.developerReloadStamp = stamp
                    self.reloadDeveloperRuntime()
                }
            } else {
                self.developerReloadStamp = stamp
            }
        }
    }

    private func modificationDate(of url: URL) -> Date? {
        (try? FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate]) as? Date
    }

    private func startDaemon() {
        guard let resources = Bundle.main.resourceURL else {
            showMessage(title: "启动失败", detail: "找不到应用资源。")
            return
        }
        let runtime = developerRoot ?? resources.appendingPathComponent("runtime", isDirectory: true)
        let configuredNode = ProcessInfo.processInfo.environment["CLONE_AI_DEV_NODE"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let node = configuredNode.flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) }
            ?? resources.appendingPathComponent("node")
        let entry = runtime.appendingPathComponent("src/desktop-sidecar.ts")
        let client = runtime.appendingPathComponent("apps/desktop/ui/index.html")
        guard FileManager.default.fileExists(atPath: entry.path),
              FileManager.default.fileExists(atPath: client.path) else {
            showMessage(title: "开发源码不可用", detail: "找不到桌面运行时或界面源码，请检查 CLONE_AI_DEV_ROOT。")
            return
        }
        let process = Process()
        let stdout = Pipe()
        let stderr = Pipe()
        var environment = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser
        let defaultWorkspace = home.appendingPathComponent("Documents/Clone AI", isDirectory: true)
        let extraPaths = [
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "/usr/local/sbin",
            "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin",
            home.appendingPathComponent(".local/bin").path,
            home.appendingPathComponent(".npm-global/bin").path,
            home.appendingPathComponent(".bun/bin").path,
            home.appendingPathComponent("Library/pnpm").path
        ]
        environment["PATH"] = ([environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"] + extraPaths).joined(separator: ":")
        environment["CLONE_AI_DESKTOP_CLIENT_PATH"] = client.path
        environment["CLONE_AI_DESKTOP_DEFAULT_WORKSPACE"] = defaultWorkspace.path
        if developerRoot != nil { environment["CLONE_AI_DEV_MODE"] = "1" }
        environment.removeValue(forKey: "NODE_OPTIONS")
        process.executableURL = node
        process.arguments = ["--experimental-strip-types", entry.path]
        process.currentDirectoryURL = runtime
        process.environment = environment
        process.standardOutput = stdout
        process.standardError = stderr
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async { self?.receiveStdout(data) }
        }
        stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async {
                guard let self else { return }
                self.stderrBuffer = String((self.stderrBuffer + String(decoding: data, as: UTF8.self)).suffix(4000))
            }
        }
        process.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self, !self.shuttingDown else { return }
                if self.developerRestartPending {
                    self.developerRestartPending = false
                    self.daemon = nil
                    self.localURL = nil
                    self.pageReady = false
                    self.startDaemon()
                    return
                }
                self.showMessage(title: "本地运行时已停止", detail: "请关闭应用后重新打开；如果问题持续，请检查本地配置。")
                NSLog("Clone AI sidecar exited with status %d", process.terminationStatus)
            }
        }
        do {
            try process.run()
            daemon = process
        } catch {
            developerRestartPending = false
            stdout.fileHandleForReading.readabilityHandler = nil
            stderr.fileHandleForReading.readabilityHandler = nil
            showMessage(title: "启动失败", detail: "无法启动应用内的本地运行时。")
            NSLog("Clone AI sidecar launch failed: %@", error.localizedDescription)
        }
        readyTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
            guard let self, self.localURL == nil, !self.shuttingDown else { return }
            self.showMessage(title: "启动超时", detail: "本地运行时没有及时就绪。请关闭应用后重新打开。")
        }
    }

    private func receiveStdout(_ data: Data) {
        stdoutBuffer += String(decoding: data, as: UTF8.self)
        while let newline = stdoutBuffer.firstIndex(of: "\n") {
            let line = String(stdoutBuffer[..<newline]).trimmingCharacters(in: .whitespacesAndNewlines)
            stdoutBuffer.removeSubrange(...newline)
            guard line.hasPrefix("CLONE_AI_READY "), localURL == nil else { continue }
            let value = String(line.dropFirst("CLONE_AI_READY ".count))
            guard let url = URL(string: value), url.scheme == "http", url.host == "127.0.0.1", url.port != nil else {
                showMessage(title: "启动失败", detail: "本地运行时返回了无效地址。")
                return
            }
            localURL = url
            readyTimer?.invalidate()
            readyTimer = nil
            startupDotTimer?.invalidate()
            startupDotTimer = nil
            webView.frame = window.contentLayoutRect
            window.contentView = webView
            webView.load(URLRequest(url: url))
            print("CLONE_AI_DESKTOP_READY \(url.absoluteString)")
            fflush(stdout)
            if ProcessInfo.processInfo.arguments.contains("--preview-pending") {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
                    let script = """
                    window.fetch = new Proxy(window.fetch, {
                      apply(target, thisArg, args) {
                        if (args[0] === '/api/main-agent/stream') return new Promise(() => {});
                        return Reflect.apply(target, thisArg, args);
                      }
                    });
                    document.getElementById('query').value = '整理今天需要推进的事情';
                    document.getElementById('request-form').requestSubmit();
                    """
                    self?.webView.evaluateJavaScript(script)
                }
            }
            if ProcessInfo.processInfo.arguments.contains("--preview-markdown") {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
                    let script = """
                    const rawText = Array.from({length: 10}, (_, index) =>
                      '第 ' + (index + 1) + ' 项：这是用于验收的较长回复，包含需要换行展示的说明，以及**重点标记**和 `行内代码`。'
                    ).join('\\n');
                    const markdown = "## 今天的推进顺序\\n\\n" + rawText + "\\n\\n1. **先处理阻塞项**\\n2. 再确认等待他人的事项\\n3. 最后整理可延后任务\\n\\n```text\\n/Users/qihoo/.clone\\n```";
                    const conversation = document.getElementById('conversation-inner');
                    conversation.querySelector('.welcome')?.remove();
                    conversation.insertAdjacentHTML('beforeend', `
                      <article class="message person"><div class="message-heading"><b>你</b><time>现在</time></div><div class="message-body"><div class="message-copy">整理今天的事项</div></div></article>
                      <article class="message clone"><div class="message-heading"><b>clone-ai</b><time>现在</time></div><div class="message-body"><div class="clone-card"><div class="clone-text collapsible collapsed">${window.cloneMarkdownForPreview(markdown)}</div><button class="clone-expand" type="button" data-expand>展开全部</button></div></div></article>
                    `);
                    """
                    self?.webView.evaluateJavaScript(script)
                }
            }
            if ProcessInfo.processInfo.arguments.contains("--test-close-window") {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                    guard let self else { return }
                    self.window.performClose(nil)
                    print("CLONE_AI_DESKTOP_WINDOW_CLOSED")
                    fflush(stdout)
                }
            }
        }
        if stdoutBuffer.count > 16_384 { stdoutBuffer = String(stdoutBuffer.suffix(16_384)) }
    }

    private func showMessage(title: String, detail: String) {
        if window.contentView !== startupView {
            window.contentView = startupView
        }
        startupTitle.stringValue = title
        startupDetail.stringValue = detail
    }

    private func makeStartupView() -> NSView {
        let container = NSView(frame: NSRect(x: 0, y: 0, width: 1240, height: 820))
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor(calibratedRed: 0.949, green: 0.945, blue: 0.918, alpha: 1).cgColor

        startupDot = NSView()
        startupDot.wantsLayer = true
        startupDot.layer?.cornerRadius = 11
        startupDot.layer?.backgroundColor = NSColor(calibratedRed: 0.137, green: 0.407, blue: 0.31, alpha: 1).cgColor
        startupDot.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            startupDot.widthAnchor.constraint(equalToConstant: 22),
            startupDot.heightAnchor.constraint(equalToConstant: 22),
        ])
        startupDotTimer = Timer.scheduledTimer(withTimeInterval: 1.1, repeats: true) { [weak self] _ in
            guard let layer = self?.startupDot.layer else { return }
            let animation = CABasicAnimation(keyPath: "opacity")
            animation.fromValue = 1
            animation.toValue = 0.38
            animation.duration = 0.55
            animation.autoreverses = true
            animation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            layer.add(animation, forKey: "startup-pulse")
        }

        startupTitle = NSTextField(labelWithString: "正在启动 Clone AI")
        startupTitle.font = NSFont.systemFont(ofSize: 22, weight: .semibold)
        startupTitle.textColor = NSColor(calibratedRed: 0.125, green: 0.145, blue: 0.129, alpha: 1)
        startupTitle.alignment = .center

        startupDetail = NSTextField(wrappingLabelWithString: "正在启动本地运行时，请稍候。")
        startupDetail.font = NSFont.systemFont(ofSize: 13)
        startupDetail.textColor = NSColor(calibratedRed: 0.38, green: 0.41, blue: 0.38, alpha: 1)
        startupDetail.alignment = .center
        startupDetail.maximumNumberOfLines = 3

        let stack = NSStackView(views: [startupDot, startupTitle, startupDetail])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: container.centerYAnchor, constant: -12),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: 460),
        ])
        return container
    }

    private func installMenu() {
        let bar = NSMenu()
        let appItem = NSMenuItem(title: "Clone AI", action: nil, keyEquivalent: "")
        bar.addItem(appItem)
        let appMenu = NSMenu(title: "Clone AI")
        let about = NSMenuItem(title: "关于 Clone AI", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        about.target = NSApp
        appMenu.addItem(about)
        appMenu.addItem(.separator())
        let settings = NSMenuItem(title: "设置…", action: #selector(showSettingsFromMenu(_:)), keyEquivalent: ",")
        settings.target = self
        appMenu.addItem(settings)
        appMenu.addItem(.separator())
        let servicesItem = NSMenuItem(title: "服务", action: nil, keyEquivalent: "")
        let servicesMenu = NSMenu(title: "服务")
        servicesItem.submenu = servicesMenu
        appMenu.addItem(servicesItem)
        NSApp.servicesMenu = servicesMenu
        appMenu.addItem(.separator())
        let hide = NSMenuItem(title: "隐藏 Clone AI", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        hide.target = NSApp
        appMenu.addItem(hide)
        let hideOthers = NSMenuItem(title: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        hideOthers.target = NSApp
        appMenu.addItem(hideOthers)
        let showAll = NSMenuItem(title: "显示全部", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        showAll.target = NSApp
        appMenu.addItem(showAll)
        appMenu.addItem(.separator())
        let quit = NSMenuItem(title: "退出 Clone AI", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quit.target = NSApp
        appMenu.addItem(quit)
        appItem.submenu = appMenu

        let fileItem = NSMenuItem(title: "文件", action: nil, keyEquivalent: "")
        bar.addItem(fileItem)
        let fileMenu = NSMenu(title: "文件")
        let newTask = NSMenuItem(title: "新建任务", action: #selector(newTaskFromMenu(_:)), keyEquivalent: "n")
        newTask.target = self
        fileMenu.addItem(newTask)
        let schedules = NSMenuItem(title: "定时任务", action: #selector(openSchedulesFromMenu(_:)), keyEquivalent: "t")
        schedules.keyEquivalentModifierMask = [.command, .shift]
        schedules.target = self
        fileMenu.addItem(schedules)
        fileMenu.addItem(.separator())
        let close = NSMenuItem(title: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        close.target = nil
        fileMenu.addItem(close)
        fileItem.submenu = fileMenu

        let editItem = NSMenuItem(title: "编辑", action: nil, keyEquivalent: "")
        bar.addItem(editItem)
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu

        let viewItem = NSMenuItem(title: "视图", action: nil, keyEquivalent: "")
        bar.addItem(viewItem)
        let viewMenu = NSMenu(title: "视图")
        for (index, title) in navigationTitles.enumerated() {
            let item = NSMenuItem(title: title, action: #selector(navigateFromMenu(_:)), keyEquivalent: String(index + 1))
            item.tag = index
            item.keyEquivalentModifierMask = [.command]
            item.target = self
            viewMenu.addItem(item)
        }
        viewMenu.addItem(.separator())
        let fullScreen = NSMenuItem(title: "进入全屏幕", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        viewMenu.addItem(fullScreen)
        viewItem.submenu = viewMenu

        let windowItem = NSMenuItem(title: "窗口", action: nil, keyEquivalent: "")
        bar.addItem(windowItem)
        let windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "缩放", action: #selector(NSWindow.zoom(_:)), keyEquivalent: "")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "前置全部窗口", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        windowItem.submenu = windowMenu
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = bar
    }

    private func installSignalHandlers() {
        for signalNumber in [SIGTERM, SIGINT] {
            signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
            source.setEventHandler {
                NSApp.terminate(nil)
            }
            source.resume()
            signalSources.append(source)
        }
        signal(SIGUSR1, SIG_IGN)
        let reloadSource = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
        reloadSource.setEventHandler { [weak self] in
            self?.reloadDeveloperRuntime()
        }
        reloadSource.resume()
        signalSources.append(reloadSource)
    }
}

let application = NSApplication.shared
let delegate = CloneAIDesktop()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
