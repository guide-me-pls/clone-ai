/**
 * Attachment panel benchmark (macOS AppKit).
 *
 * Measures how long NSOpenPanel takes to build and become visible with the
 * same content types the desktop shell uses, comparing the window sheet
 * (`beginSheetModal`) with the app-modal presentation (`begin`) and measuring
 * the effect of warming the first construction. The window sits offscreen, so
 * the panels are not user-visible; the harness takes a few seconds.
 *
 * Build and run:
 *   swiftc -O -target arm64-apple-macos13.5 benchmark/attachment-panel.swift \
 *     -framework AppKit -framework UniformTypeIdentifiers -o /tmp/attachment-panel
 *   /tmp/attachment-panel > benchmark/results/attachment-panel-<timestamp>.json
 *
 * 附件面板基准（macOS AppKit）。
 *
 * 用桌面外壳相同的内容类型测量 NSOpenPanel 的构造与可见耗时，比较窗口 sheet
 * （`beginSheetModal`）与应用级模态（`begin`），并测量预热第一次构造的效果。
 * 窗口在屏幕外，因此面板对用户不可见；整个测量只需数秒。
 */
import AppKit
import UniformTypeIdentifiers

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let window = NSWindow(
    contentRect: NSRect(x: -4000, y: -4000, width: 900, height: 600),
    styleMask: [.titled],
    backing: .buffered,
    defer: false
)
window.orderBack(nil)

let contentTypes: [UTType] = [.image, .movie, .text, .json, .commaSeparatedText, .pdf]
    + ["docx", "doc"].compactMap { UTType(filenameExtension: $0) }

func makePanel() -> NSOpenPanel {
    let panel = NSOpenPanel()
    panel.title = "添加图片、视频或文档"
    panel.canChooseFiles = true
    panel.canChooseDirectories = false
    panel.allowsMultipleSelection = true
    panel.resolvesAliases = true
    panel.allowedContentTypes = contentTypes
    return panel
}

func pump(_ seconds: Double) {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.01))
    }
}

func waitVisible(_ panel: NSOpenPanel, _ started: CFAbsoluteTime) -> Int {
    let deadline = Date().addingTimeInterval(8)
    while Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        if panel.isVisible { return Int((CFAbsoluteTimeGetCurrent() - started) * 1000) }
    }
    return -1
}

var measurements: [[String: Any]] = []

func measure(_ label: String, mode: String) {
    let start = CFAbsoluteTimeGetCurrent()
    let panel = makePanel()
    let buildMs = Int((CFAbsoluteTimeGetCurrent() - start) * 1000)
    if mode == "begin" {
        panel.begin { _ in }
    } else {
        panel.beginSheetModal(for: window) { _ in }
    }
    let visibleMs = waitVisible(panel, start)
    measurements.append([
        "label": label,
        "mode": mode,
        "buildMs": buildMs,
        "visibleMs": visibleMs,
    ])
    panel.cancel(nil)
    pump(0.3)
}

// The first panel in a process pays the AppKit/LaunchServices cold start; this
// is the cost the owner's first click sees today.
measure("first-sheet-cold", mode: "sheet")

// Warm only the construction, then compare the two presentations.
let buildWarmStart = CFAbsoluteTimeGetCurrent()
_ = makePanel()
measurements.append(["label": "construction-warm", "mode": "none", "buildMs": Int((CFAbsoluteTimeGetCurrent() - buildWarmStart) * 1000)])
pump(0.5)
measure("sheet-after-construction-warm", mode: "sheet")

// Warm the panel service with an offscreen show/cancel, then measure again.
let showWarmStart = CFAbsoluteTimeGetCurrent()
let warmPanel = makePanel()
warmPanel.beginSheetModal(for: window) { _ in }
_ = waitVisible(warmPanel, showWarmStart)
measurements.append(["label": "show-warm", "mode": "sheet", "visibleMs": Int((CFAbsoluteTimeGetCurrent() - showWarmStart) * 1000)])
warmPanel.cancel(nil)
pump(0.5)
measure("sheet-after-show-warm", mode: "sheet")
measure("begin-after-show-warm", mode: "begin")

let payload: [String: Any] = [
    "kind": "attachment-panel-benchmark",
    "date": ISO8601DateFormatter().string(from: Date()),
    "machine": [
        "platform": "macOS",
        "os": ProcessInfo.processInfo.operatingSystemVersionString,
        "cores": ProcessInfo.processInfo.activeProcessorCount,
        "memoryBytes": ProcessInfo.processInfo.physicalMemory,
    ],
    "parameters": [
        "allowedContentTypes": contentTypes.map { $0.identifier },
        "window": "offscreen titled 900x600",
        "waitLimitMs": 8000,
    ],
    "measurements": measurements,
    "notes": [
        "buildMs is the synchronous NSOpenPanel construction; visibleMs includes presenting the panel and its file view.",
        "The first panel in a process pays a one-time cold start; later panels are warm.",
        "The harness window is offscreen, so the panels are not user-visible; absolute times may differ from the packaged app.",
    ],
]
let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
print(String(data: data, encoding: .utf8) ?? "{}")