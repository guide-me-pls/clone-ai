/**
 * Native video-frame benchmark (macOS AVFoundation).
 *
 * Measures the frame the desktop shell now extracts for a video chosen through
 * the picker: one 1280 px JPEG at 1 s, first (cold) and warm. Compare it with
 * the WKWebView `<video>` path, which measured ~1.07–1.28 s for the same file.
 *
 * Build and run:
 *   swiftc -O -target arm64-apple-macos13.5 benchmark/video-frame.swift \
 *     -framework AppKit -framework AVFoundation -o /tmp/video-frame-bench
 *   /tmp/video-frame-bench <video path> > benchmark/results/video-frame-<timestamp>.json
 *
 * 原生视频抽帧基准（macOS AVFoundation）。
 *
 * 测量桌面外壳现在为通过选择器选中的视频抽取的帧：1 秒处的一张 1280px JPEG，第一次
 * （冷）与热。可与 WKWebView `<video>` 路径对比：同一个文件测得约 1.07–1.28 秒。
 */
import AppKit
import AVFoundation

let path = CommandLine.arguments.dropFirst().first
    ?? "/Users/qihoo/study/clone-ai/eval-runs/2026-11-17-forbidden-city/verify/f/video.mp4"
let url = URL(fileURLWithPath: path)
let trials = 3
var measurements: [[String: Any]] = []
var dimensions: [Int] = []
var bytes = 0

for trial in 0..<trials {
    let started = CFAbsoluteTimeGetCurrent()
    let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: 1280, height: 1280)
    var ms = 0
    if let image = try? generator.copyCGImage(at: CMTime(seconds: 1, preferredTimescale: 600), actualTime: nil) {
        let data = NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: 0.86])
        ms = Int((CFAbsoluteTimeGetCurrent() - started) * 1000)
        dimensions = [image.width, image.height]
        bytes = data?.count ?? 0
    } else {
        ms = -1
    }
    measurements.append(["trial": trial, "ms": ms, "width": dimensions.first ?? 0, "height": dimensions.count > 1 ? dimensions[1] : 0, "jpegBytes": bytes])
}

let payload: [String: Any] = [
    "kind": "video-frame-benchmark",
    "date": ISO8601DateFormatter().string(from: Date()),
    "provider": "none",
    "machine": [
        "platform": "macOS",
        "os": ProcessInfo.processInfo.operatingSystemVersionString,
        "cores": ProcessInfo.processInfo.activeProcessorCount,
    ],
    "parameters": [
        "video": path,
        "timestampSeconds": 1.0,
        "maximumSize": 1280,
        "jpegQuality": 0.86,
        "trials": trials,
    ],
    "measurements": measurements,
    "notes": [
        "The first trial includes AVFoundation/asset cold start; later trials reuse the media cache.",
        "The WKWebView <video> path measured 1,065–1,277 ms for the same file; its JPEG encode was only 10–19 ms.",
    ],
]
let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
print(String(data: data, encoding: .utf8) ?? "{}")