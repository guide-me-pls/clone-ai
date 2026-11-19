import AppKit
import AVFoundation
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
    private var sidecarStderr = ""
    private var localURL: URL?
    private var shuttingDown = false
    private var readyTimer: Timer?
    private var signalSources: [DispatchSourceSignal] = []
    private var selectedNavigationIndex = 0
    private var pendingNavigationIndex: Int?
    private var pageReady = false
    // The attachment panel's first construction is cold (AppKit/LaunchServices);
    // warming it once after the page is ready keeps that cost off the first
    // click. 附件面板第一次构造是冷的（AppKit/LaunchServices）；页面就绪后预热一次，
    // 把这份成本移出第一次点击。
    private var attachmentPanelWarmed = false
    // Video frames come from AVFoundation instead of WKWebView's media pipeline;
    // extraction runs off the main thread. 视频帧来自 AVFoundation，而不是 WKWebView 的
    // 媒体管线；抽取在主线程之外运行。
    private let videoFrameQueue = DispatchQueue(label: "ai.clone.video-frame", qos: .userInitiated, attributes: .concurrent)
    private var developerRoot: URL?
    private var developerRestartPending = false
    private var developerReloadMarker: URL?
    private var developerReloadStamp: Date?
    private var developerReloadTimer: Timer?
    private var restartTimer: Timer?
    private var restartAttempts = 0
    private var restartScheduled = false
    private var healthTimer: Timer?
    private var healthFailures = 0
    private var residentRetryTimer: Timer?
    private var lastExitSummary = ""

    /**
     * Resident mode, decided once at launch: launchd owns the runtime, so
     * quitting this app must not kill it. The app is a window onto a daemon
     * that outlives it.
     *
     * A packaged launch from Finder carries no environment, so the explicit
     * variable cannot be the only signal: when the LaunchAgent is loaded the
     * window attaches instead of spawning a second writer on the same journal.
     *
     * 常驻模式，在启动时决定一次：由 launchd 托管运行时，因此退出本 App 不得杀死它。
     * App 是通往一个比它活得更久的 Daemon 的一扇窗。
     *
     * 从 Finder 打开的打包 App 没有环境变量，因此不能只靠显式变量：LaunchAgent 已加载时
     * 窗口选择附着，而不是在同一个 Journal 上再拉起一个写者。
     */
    private var residentRuntime = false

    private static let launchAgentLabel = "ai.clone.companion"

    /**
     * Ask launchd whether the job exists in this user's GUI domain. A loaded
     * job that is temporarily dead still counts: launchd owns the restart, and
     * the window retries the endpoint instead of starting a rival runtime.
     * 向 launchd 询问该任务是否存在于当前用户的 GUI 域。已加载但暂时死掉的任务仍算数：
     * 重启由 launchd 负责，窗口重试端点，而不是启动一个竞争运行时。
     */
    private func launchAgentIsLoaded() -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["print", "gui/\(getuid())/\(Self.launchAgentLabel)"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus == 0
        } catch {
            return false
        }
    }

    /**
     * The clone home: the same resolution the daemon uses (CLONE_HOME, then
     * CLONE_AI_HOME, then CLONE_AI_DATA_DIR, then ~/.clone). A second path
     * resolver in the shell would let the window attach to a different home
     * than the one launchd supervises.
     * Clone home：与 Daemon 相同的解析顺序。外壳里再写一套解析，会让窗口附着到与
     * launchd 托管的家目录不同的地方。
     */
    private var cloneHomeDirectory: URL {
        let environment = ProcessInfo.processInfo.environment
        for key in ["CLONE_HOME", "CLONE_AI_HOME", "CLONE_AI_DATA_DIR"] {
            if let value = environment[key]?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
                return URL(fileURLWithPath: value, isDirectory: true)
            }
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".clone", isDirectory: true)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let configuredRoot = ProcessInfo.processInfo.environment["CLONE_AI_DEV_ROOT"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !configuredRoot.isEmpty {
            developerRoot = URL(fileURLWithPath: configuredRoot, isDirectory: true).standardizedFileURL
        }
        // A packaged launch decides once: an explicit variable wins; otherwise
        // a loaded LaunchAgent means the window attaches; a checkout without
        // the job keeps a private runtime. Developer builds keep theirs unless
        // the variable is explicit.
        // 打包启动只决定一次：显式变量优先；否则已加载的 LaunchAgent 意味着附着；没有该
        // 任务的检出保留私有运行时。开发构建除非显式设置变量，否则始终保留私有运行时。
        let explicitResident = ProcessInfo.processInfo.environment["CLONE_AI_RESIDENT_DAEMON"] == "1"
        residentRuntime = explicitResident || (developerRoot == nil && launchAgentIsLoaded())
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
              }),
              onVideoFrame: (key, dataUrl) => {
                const waiters = window.CloneNativeVideoWaiters;
                const waiter = waiters ? waiters[key] : undefined;
                if (typeof waiter === "function") {
                  delete waiters[key];
                  waiter(dataUrl ?? undefined);
                  return;
                }
                if (typeof dataUrl === "string" && dataUrl.length > 0) {
                  (window.CloneNativeVideoFrames ??= {})[key] = dataUrl;
                }
              },
              videoFrame: (key) => new Promise((resolve) => {
                const frames = window.CloneNativeVideoFrames;
                const ready = frames ? frames[key] : undefined;
                if (typeof ready === "string") {
                  delete frames[key];
                  resolve(ready);
                  return;
                }
                const waiters = (window.CloneNativeVideoWaiters ??= {});
                const timer = setTimeout(() => {
                  delete waiters[key];
                  resolve(undefined);
                }, 1500);
                waiters[key] = (dataUrl) => {
                  clearTimeout(timer);
                  resolve(typeof dataUrl === "string" && dataUrl.length > 0 ? dataUrl : undefined);
                };
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
        stopSupervision()
        // A resident daemon is launchd's child, not ours: killing it here would
        // make quitting the window stop the twin, which is the bug this mode
        // exists to remove. Detach and let launchd keep it.
        // 常驻 Daemon 是 launchd 的子进程，不是我们的：在这里杀掉它，会让关闭窗口等于停掉
        // 分身，而这正是本模式要移除的缺陷。断开即可，交给 launchd 继续托管。
        if residentRuntime {
            shuttingDown = true
            daemon = nil
            return .terminateNow
        }
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
            // After the window is interactive, pay the cold panel construction
            // once so the first attach click builds in ~100 ms instead of ~400.
            // 窗口可交互后先支付一次冷构造，使第一次附件点击的构造约为 100ms 而不是 400ms。
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                self?.warmAttachmentPanel()
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
        } else if purpose == "export" {
            panel.title = "选择数据导出位置"
            panel.message = "Clone AI 会在这个文件夹里新建一个带时间戳的导出目录。"
        } else if purpose == "table-export" {
            panel.title = "选择表格导出位置"
            panel.message = "Clone AI 会在这个文件夹里写入一个 CSV 文件，可直接用 Excel 打开。"
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
        // A click before the delayed warm-up must not be followed by a second
        // throwaway construction. 延迟预热之前的点击之后不应再构造一个丢弃面板。
        attachmentPanelWarmed = true
        let panel = NSOpenPanel()
        panel.title = "添加图片、视频或文档"
        panel.message = "选择要发送给 Clone AI 的图片、视频或文本文件。"
        panel.prompt = "添加"
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.resolvesAliases = true
        panel.allowedContentTypes = [.image, .movie, .text, .json, .commaSeparatedText, .pdf]
            + ["docx", "doc"].compactMap { UTType(filenameExtension: $0) }
        // A sheet animates for ~270 ms before the file view appears; the
        // app-modal panel appears in ~120 ms. The owner asked for the click to
        // answer faster, and the selected URLs reach the WebView the same way.
        // sheet 在文件视图出现前要播放约 270ms 动画；应用级模态面板约 120ms 出现。
        // 所有者要求点击更快响应，选中的 URL 仍以同样方式交回 WebView。
        panel.begin { [weak self] response in
            guard response == .OK, !panel.urls.isEmpty else {
                completionHandler(nil)
                return
            }
            // Start the native frame extraction before WebKit delivers the
            // files; the page's videoFrame waits for it and falls back to HTML
            // video if it fails. 在 WebKit 交付文件之前开始原生抽帧；页面的
            // videoFrame 会等待它，失败时回退到 HTML video。
            self?.deliverVideoFrames(panel.urls)
            completionHandler(panel.urls)
        }
    }

    private func isVideoURL(_ url: URL) -> Bool {
        guard let type = UTType(filenameExtension: url.pathExtension) else { return false }
        return type.conforms(to: .movie) || type.conforms(to: .video)
    }

    private func videoFrameKey(for url: URL) -> String? {
        guard let values = try? url.resourceValues(forKeys: [.fileSizeKey]),
              let size = values.fileSize else { return nil }
        return "\(url.lastPathComponent):\(size)"
    }

    /**
     * One 1280 px JPEG at 1 s (0.1 s for very short clips). AVFoundation reads
     * the local file directly; WKWebView's media pipeline needed ~1.1 s for the
     * same 8 MB video. 1 秒处的一张 1280px JPEG（很短的文件用 0.1 秒）。
     * AVFoundation 直接读取本地文件；WKWebView 的媒体管线对同一个 8MB 视频约需 1.1 秒。
     */
    private func videoFrameDataURL(_ url: URL) -> String? {
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 1280, height: 1280)
        for seconds in [1.0, 0.1] {
            guard let image = try? generator.copyCGImage(
                at: CMTime(seconds: seconds, preferredTimescale: 600),
                actualTime: nil
            ) else { continue }
            guard let data = NSBitmapImageRep(cgImage: image).representation(
                using: .jpeg,
                properties: [.compressionFactor: 0.86]
            ) else { continue }
            return "data:image/jpeg;base64,\(data.base64EncodedString())"
        }
        return nil
    }

    /**
     * Extracts every selected video concurrently and hands each frame to the
     * page by name:size. A null result tells the page to fall back immediately
     * instead of waiting for the 1.5 s timeout.
     * 并发抽取每个选中的视频，并按 name:size 把帧交给页面。null 结果让页面立即回退，
     * 而不是等满 1.5 秒超时。
     */
    private func deliverVideoFrames(_ urls: [URL]) {
        for url in urls where isVideoURL(url) {
            guard let key = videoFrameKey(for: url) else { continue }
            videoFrameQueue.async { [weak self] in
                let frame = self?.videoFrameDataURL(url)
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    let keyLiteral = self.javaScriptStringLiteral(key)
                    let frameLiteral = frame.map { self.javaScriptStringLiteral($0) } ?? "null"
                    self.webView.evaluateJavaScript(
                        "window.CloneNative?.onVideoFrame?.(\(keyLiteral), \(frameLiteral));"
                    )
                }
            }
        }
    }

    /**
     * Constructs one throwaway attachment panel with the real content types so
     * AppKit and LaunchServices are warm before the owner's first click. It is
     * never shown; the construction cost is paid on an idle main thread 1.5 s
     * after the page is ready.
     * 用真实内容类型构造一个丢弃的附件面板，使 AppKit 与 LaunchServices 在所有者第一次
     * 点击之前已经预热。它从不显示；构造成本在页面就绪 1.5 秒后的空闲主线程上支付。
     */
    private func warmAttachmentPanel() {
        guard !attachmentPanelWarmed else { return }
        attachmentPanelWarmed = true
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.resolvesAliases = true
        panel.allowedContentTypes = [.image, .movie, .text, .json, .commaSeparatedText, .pdf]
            + ["docx", "doc"].compactMap { UTType(filenameExtension: $0) }
        _ = panel
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        pageReady = false
    }

    /**
     * A failed load is the other way a stale endpoint announces itself: the URL
     * parses, the port is dead. The health probe would find it five seconds
     * later; failing here recovers at once instead of showing a blank page.
     * 加载失败是陈旧端点的另一种自白：URL 合法，端口已死。健康探测要五秒后才发现；这里
     * 立即恢复，而不是显示一张空白页。
     */
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.shuttingDown, self.localURL != nil else { return }
            self.recoverFromUnhealthyRuntime(reason: error.localizedDescription)
        }
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
        restartTimer?.invalidate()
        restartTimer = nil
        restartScheduled = false
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

    /**
     * Launch the runtime. In resident mode it is not spawned here — launchd
     * already runs it — so the app attaches to the published endpoint instead.
     * 启动运行时。常驻模式下它不由这里启动——launchd 已在跑——因此 App 改为附着到
     * 已发布的端点上。
     */
    private func startDaemon(reconnecting: Bool = false) {
        if residentRuntime {
            attachToResidentDaemon(reconnecting: reconnecting)
            return
        }
        readyTimer?.invalidate()
        readyTimer = nil
        // Each attempt starts with a clean reason; a timeout or a launch error
        // fills it before the next failure can be reported.
        // 每次尝试都从空原因开始；超时或启动错误会在下一次失败上报之前填入它。
        lastExitSummary = ""
        sidecarStderr = ""
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
        let documentTool = resources.appendingPathComponent("CloneAIDocumentTool")
        if FileManager.default.isExecutableFile(atPath: documentTool.path) {
            environment["CLONE_AI_DOCUMENT_TOOL"] = documentTool.path
        }
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
                self.sidecarStderr = String((self.sidecarStderr + String(decoding: data, as: UTF8.self)).suffix(4000))
            }
        }
        process.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self, !self.shuttingDown else { return }
                // Under launchd, an exit is a crash: launchd restarts it, and the
                // window must follow the new port instead of showing an error.
                // 在 launchd 之下，退出即崩溃：launchd 会重启它，窗口必须跟随新端口，
                // 而不是显示错误。
                if self.residentRuntime {
                    self.daemon = nil
                    self.localURL = nil
                    self.pageReady = false
                    self.stopHealthMonitor()
                    self.startDaemon(reconnecting: true)
                    return
                }
                if self.developerRestartPending {
                    self.developerRestartPending = false
                    self.daemon = nil
                    self.localURL = nil
                    self.pageReady = false
                    self.stopHealthMonitor()
                    self.startDaemon()
                    return
                }
                self.daemon = nil
                if self.lastExitSummary.isEmpty {
                    self.lastExitSummary = "退出状态 \(process.terminationStatus)"
                }
                NSLog("Clone AI sidecar exited with status %d", process.terminationStatus)
                self.scheduleRuntimeRestart()
            }
        }
        do {
            try process.run()
            daemon = process
        } catch {
            developerRestartPending = false
            stdout.fileHandleForReading.readabilityHandler = nil
            stderr.fileHandleForReading.readabilityHandler = nil
            daemon = nil
            NSLog("Clone AI sidecar launch failed: %@", error.localizedDescription)
            lastExitSummary = "无法启动：\(error.localizedDescription)"
            scheduleRuntimeRestart()
            return
        }
        readyTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
            guard let self, self.localURL == nil, !self.shuttingDown else { return }
            self.handleStartupTimeout()
        }
    }

    /**
     * Attach to the daemon launchd is supervising: read the endpoint file it
     * publishes and load it. Retries while launchd starts or restarts the job,
     * so a crash-loop still surfaces as a window that recovers.
     * 附着到 launchd 托管的 Daemon：读取它发布的端点文件并加载。在 launchd 启动或
     * 重启任务期间重试，使崩溃循环表现为一个能自行恢复的窗口。
     */
    private func attachToResidentDaemon(reconnecting: Bool) {
        guard !shuttingDown else { return }
        if !reconnecting {
            showMessage(title: "正在连接", detail: "正在连接常驻运行时，请稍候。")
        }
        let endpointFile = cloneHomeDirectory.appendingPathComponent("companion-endpoint.json")
        guard let data = try? Data(contentsOf: endpointFile),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let value = parsed["url"] as? String,
              let url = URL(string: value), url.scheme == "http", url.host == "127.0.0.1", url.port != nil else {
            // launchd may not have written the file yet, or is restarting the job.
            // launchd 可能还没写文件，或正在重启任务。
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                guard let self, !self.shuttingDown else { return }
                self.residentAttempts += 1
                if self.residentAttempts > 120 {
                    self.residentAttempts = 0
                    self.retryResidentAttach(reason: "launchd 没有在 60 秒内发布端点。")
                    return
                }
                self.attachToResidentDaemon(reconnecting: true)
            }
            return
        }
        residentAttempts = 0
        localURL = url
        readyTimer?.invalidate()
        readyTimer = nil
        startupDotTimer?.invalidate()
        startupDotTimer = nil
        residentRetryTimer?.invalidate()
        residentRetryTimer = nil
        restartTimer?.invalidate()
        restartTimer = nil
        restartScheduled = false
        restartAttempts = 0
        lastExitSummary = ""
        webView.frame = window.contentLayoutRect
        window.contentView = webView
        webView.load(URLRequest(url: url))
        startHealthMonitor()
        print("CLONE_AI_DESKTOP_READY \(url.absoluteString)")
        fflush(stdout)
    }

    private var residentAttempts = 0

    /**
     * Stop every supervision timer before the process exits. A restart timer
     * that fires during AppKit's synchronous termination would spawn a sidecar
     * whose parent is already leaving.
     *
     * 退出前停掉所有监管定时器。在 AppKit 同步终止期间触发的重启定时器会拉起一个父进程
     * 已在离开的 sidecar。
     */
    private func stopSupervision() {
        restartTimer?.invalidate()
        restartTimer = nil
        healthTimer?.invalidate()
        healthTimer = nil
        residentRetryTimer?.invalidate()
        residentRetryTimer = nil
        readyTimer?.invalidate()
        readyTimer = nil
        restartScheduled = false
    }

    /**
     * Nothing supervises a sidecar the app spawned itself: when it exited, this
     * view used to become a dead end. Relaunch it with exponential backoff and
     * keep the last stderr lines on screen, so a crash loop is observable
     * instead of silent. Resident mode is different — launchd owns that process
     * and the window follows the endpoint file.
     *
     * 自行拉起的 sidecar 没有任何监管：过去它一退出，这个窗口就是终点。现在按指数退避
     * 重启，并把最后的 stderr 留在屏幕上，使崩溃循环可观察而不是无声。常驻模式不同——
     * 那个进程属于 launchd，窗口跟随端点文件。
     */
    private func scheduleRuntimeRestart() {
        guard !shuttingDown, !residentRuntime, !developerRestartPending, !restartScheduled else { return }
        restartScheduled = true
        restartAttempts += 1
        stopHealthMonitor()
        readyTimer?.invalidate()
        readyTimer = nil
        localURL = nil
        pageReady = false
        let delay = min(30.0, pow(2.0, Double(max(0, restartAttempts - 1))))
        let seconds = Int(delay.rounded())
        var detail = "第 \(restartAttempts) 次自动重启，\(seconds) 秒后重试。"
        if !lastExitSummary.isEmpty { detail += "\n上次退出：\(lastExitSummary)" }
        if let tail = sidecarStderrTail() { detail += "\n\(tail)" }
        showMessage(title: "本地运行时已停止，正在自动重启", detail: detail)
        restartTimer?.invalidate()
        restartTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            guard let self, !self.shuttingDown else { return }
            self.restartScheduled = false
            self.startDaemon(reconnecting: true)
        }
    }

    /**
     * A sidecar that has not printed CLONE_AI_READY after 30 seconds is stuck,
     * not slow: restart it rather than report a timeout the owner can only
     * answer by quitting.
     *
     * 30 秒仍未打印 CLONE_AI_READY 的 sidecar 是卡住，不是慢：重启它，而不是报一个只能
     * 靠退出应用回答的超时。
     */
    private func handleStartupTimeout() {
        guard !shuttingDown, localURL == nil else { return }
        lastExitSummary = "启动超时：30 秒内没有就绪"
        if let process = daemon, process.isRunning {
            process.terminate()
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self, weak process] in
                guard let self, !self.shuttingDown, let process, process.isRunning else { return }
                Darwin.kill(process.processIdentifier, SIGKILL)
                self.daemon = nil
                self.scheduleRuntimeRestart()
            }
            return
        }
        daemon = nil
        scheduleRuntimeRestart()
    }

    /** The last lines the sidecar wrote to stderr, bounded for the startup view. 启动页展示所用的 sidecar stderr 尾行（有界）。 */
    private func sidecarStderrTail() -> String? {
        let lines = sidecarStderr
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard !lines.isEmpty else { return nil }
        return String(lines.suffix(4).joined(separator: "\n").suffix(600))
    }

    /**
     * A process that is alive but no longer answers is the failure the exit
     * handler cannot see: the sidecar can hang with its port still open. Probe
     * the health endpoint the server already exposes; two misses in a row mean
     * the window must re-attach or restart instead of leaving a page whose every
     * request fails.
     *
     * 进程还活着但不再应答，是退出处理器看不见的失败：sidecar 可能端口还在、服务已卡死。
     * 探测服务端已经暴露的健康端点；连续两次失败意味着窗口必须重新附着或重启，而不是留下
     * 一个每个请求都失败的页面。
     */
    private func startHealthMonitor() {
        healthTimer?.invalidate()
        healthFailures = 0
        guard localURL != nil else { return }
        healthTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.probeRuntimeHealth()
        }
    }

    private func stopHealthMonitor() {
        healthTimer?.invalidate()
        healthTimer = nil
        healthFailures = 0
    }

    private func probeRuntimeHealth() {
        guard !shuttingDown, let base = localURL else { stopHealthMonitor(); return }
        let url = base.appendingPathComponent("api/health")
        var request = URLRequest(url: url)
        request.timeoutInterval = 4
        request.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: request) { [weak self] _, response, error in
            DispatchQueue.main.async {
                // A probe from the previous runtime must not condemn the one
                // that replaced it: the URL is the generation token.
                // 上一个运行时的探测不能给接替它的运行时定罪：URL 就是代际标识。
                guard let self, !self.shuttingDown, self.localURL == base else { return }
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                if error == nil && (200..<300).contains(code) {
                    self.healthFailures = 0
                    return
                }
                self.healthFailures += 1
                guard self.healthFailures >= 2 else { return }
                self.recoverFromUnhealthyRuntime(reason: error?.localizedDescription ?? "HTTP \(code)")
            }
        }.resume()
    }

    private func recoverFromUnhealthyRuntime(reason: String) {
        guard !shuttingDown else { return }
        stopHealthMonitor()
        readyTimer?.invalidate()
        readyTimer = nil
        localURL = nil
        pageReady = false
        if residentRuntime {
            retryResidentAttach(reason: "端点无响应：\(reason)")
            return
        }
        lastExitSummary = "健康检查失败：\(reason)"
        if let process = daemon, process.isRunning {
            showMessage(title: "本地运行时无响应，正在重启", detail: "健康检查失败：\(reason)")
            process.terminate()
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self, weak process] in
                guard let self, !self.shuttingDown, let process, process.isRunning else { return }
                Darwin.kill(process.processIdentifier, SIGKILL)
                self.daemon = nil
                self.scheduleRuntimeRestart()
            }
            return
        }
        daemon = nil
        scheduleRuntimeRestart()
    }

    /**
     * launchd restarts the daemon with a new port and republishes the endpoint;
     * the window follows the file. Sixty seconds without an endpoint is not the
     * end of that story, so keep checking every 30 seconds and name the command
     * that restores the job.
     *
     * launchd 会用新端口重启 Daemon 并重新发布端点；窗口跟随该文件。60 秒读不到端点并不是
     * 故事的终点，因此每 30 秒继续检查，并说明哪条命令能恢复任务。
     */
    private func retryResidentAttach(reason: String) {
        guard !shuttingDown else { return }
        stopHealthMonitor()
        readyTimer?.invalidate()
        readyTimer = nil
        localURL = nil
        pageReady = false
        showMessage(
            title: "常驻运行时未响应，正在重试",
            detail: "\(reason)\n每 30 秒重新读取端点；可运行 scripts/install-daemon.mjs 重新安装。"
        )
        residentRetryTimer?.invalidate()
        residentRetryTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
            guard let self, !self.shuttingDown else { return }
            self.residentAttempts = 0
            self.attachToResidentDaemon(reconnecting: true)
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
            restartTimer?.invalidate()
            restartTimer = nil
            restartScheduled = false
            restartAttempts = 0
            lastExitSummary = ""
            sidecarStderr = ""
            webView.frame = window.contentLayoutRect
            window.contentView = webView
            webView.load(URLRequest(url: url))
            startHealthMonitor()
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
                    const markdown = "## 今天的推进顺序\\n\\n" + rawText + "\\n\\n1. **先处理阻塞项**\\n2. 再确认等待他人的事项\\n3. 最后整理可延后任务\\n\\n```text\\n/Users/<owner>/.clone\\n```";
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
        startStartupPulse()
        startupTitle.stringValue = title
        startupDetail.stringValue = detail
    }

    /** Keep the dot breathing whenever the startup view is on screen. 启动视图在屏上时让圆点一直呼吸。 */
    private func startStartupPulse() {
        guard startupDotTimer == nil else { return }
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
        startStartupPulse()

        startupTitle = NSTextField(labelWithString: "正在启动 Clone AI")
        startupTitle.font = NSFont.systemFont(ofSize: 22, weight: .semibold)
        startupTitle.textColor = NSColor(calibratedRed: 0.125, green: 0.145, blue: 0.129, alpha: 1)
        startupTitle.alignment = .center

        startupDetail = NSTextField(wrappingLabelWithString: "正在启动本地运行时，请稍候。")
        startupDetail.font = NSFont.systemFont(ofSize: 13)
        startupDetail.textColor = NSColor(calibratedRed: 0.38, green: 0.41, blue: 0.38, alpha: 1)
        startupDetail.alignment = .center
        startupDetail.maximumNumberOfLines = 8

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
