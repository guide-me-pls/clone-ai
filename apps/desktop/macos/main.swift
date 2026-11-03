import AppKit
import Darwin
import Foundation
import WebKit

final class CloneAIDesktop: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var daemon: Process?
    private var stdoutBuffer = ""
    private var stderrBuffer = ""
    private var localURL: URL?
    private var shuttingDown = false
    private var readyTimer: Timer?
    private var signalSources: [DispatchSourceSignal] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        installSignalHandlers()
        installMenu()
        webView = WKWebView(frame: .zero)
        webView.navigationDelegate = self
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1240, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Clone AI"
        window.minSize = NSSize(width: 720, height: 520)
        window.contentView = webView
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        showMessage(title: "正在启动 Clone AI", detail: "正在启动本地运行时，请稍候。")
        startDaemon()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

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

    private func startDaemon() {
        guard let resources = Bundle.main.resourceURL else {
            showMessage(title: "启动失败", detail: "找不到应用资源。")
            return
        }
        let runtime = resources.appendingPathComponent("runtime", isDirectory: true)
        let node = resources.appendingPathComponent("node")
        let entry = runtime.appendingPathComponent("src/desktop-sidecar.ts")
        let client = runtime.appendingPathComponent("apps/desktop/ui/index.html")
        let process = Process()
        let stdout = Pipe()
        let stderr = Pipe()
        var environment = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser
        let defaultWorkspace = home.appendingPathComponent("Documents/Clone AI", isDirectory: true)
        let extraPaths = ["/opt/homebrew/bin", "/usr/local/bin", home.appendingPathComponent(".local/bin").path]
        environment["PATH"] = ([environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"] + extraPaths).joined(separator: ":")
        environment["CLONE_AI_DESKTOP_CLIENT_PATH"] = client.path
        environment["CLONE_AI_DESKTOP_DEFAULT_WORKSPACE"] = defaultWorkspace.path
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
                self.showMessage(title: "本地运行时已停止", detail: "请关闭应用后重新打开；如果问题持续，请检查本地配置。")
                NSLog("Clone AI sidecar exited with status %d", process.terminationStatus)
            }
        }
        do {
            try process.run()
            daemon = process
        } catch {
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
            webView.load(URLRequest(url: url))
            print("CLONE_AI_DESKTOP_READY \(url.absoluteString)")
            fflush(stdout)
        }
        if stdoutBuffer.count > 16_384 { stdoutBuffer = String(stdoutBuffer.suffix(16_384)) }
    }

    private func showMessage(title: String, detail: String) {
        let html = """
        <!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
        <style>body{margin:0;background:#f6f7fb;color:#263141;font:15px -apple-system,sans-serif;display:grid;place-items:center;height:100vh}main{text-align:center}h1{font-size:21px}p{color:#667589}</style>
        <main><h1>\(title)</h1><p>\(detail)</p></main>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    private func installMenu() {
        let bar = NSMenu()
        let appItem = NSMenuItem()
        bar.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 Clone AI", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 Clone AI", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let editItem = NSMenuItem()
        bar.addItem(editItem)
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
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
    }
}

let application = NSApplication.shared
let delegate = CloneAIDesktop()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
