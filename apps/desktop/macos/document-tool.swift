/**
 * CloneAIDocumentTool — native text extraction for attachments.
 *
 * The Node runtime handles text documents, PDF text layers and .docx itself.
 * This helper covers the two cases that need macOS frameworks:
 *
 *   ocr-pdf  render each page and recognize text with Vision (image-only PDFs)
 *   doc      read a legacy Word 97 file with AppKit
 *
 * The file bytes arrive on stdin and the text leaves on stdout, so the Node side
 * never writes the owner's document to a temporary path. The helper is compiled
 * into Clone AI.app by scripts/build-macos-app.mjs.
 *
 * CloneAIDocumentTool —— 附件的原生文本提取。
 *
 * 文本文件、PDF 文本层与 .docx 由 Node 运行时处理；本助手只覆盖需要 macOS 框架的两种：
 *
 *   ocr-pdf  渲染每页并用 Vision 识别（纯图片 PDF）
 *   doc      用 AppKit 读取旧式 Word 97 文件
 *
 * 文件字节从 stdin 进入、文本从 stdout 离开，Node 侧因此从不把所有者文档写到临时路径。
 * 助手由 scripts/build-macos-app.mjs 编译进 Clone AI.app。
 */
import AppKit
import Foundation
import PDFKit
import Vision

enum ToolError: Error, LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case .message(let value): return value
        }
    }
}

struct TextItem {
    let text: String
    let box: CGRect
}

let mode = CommandLine.arguments.dropFirst().first ?? ""
let input = FileHandle.standardInput.readDataToEndOfFile()

do {
    let text: String
    switch mode {
    case "ocr-pdf":
        text = try ocrPDF(input)
    case "doc":
        text = try readLegacyDoc(input)
    default:
        throw ToolError.message("expected mode 'ocr-pdf' or 'doc'")
    }
    FileHandle.standardOutput.write(text.data(using: .utf8) ?? Data())
} catch {
    let message = "\(error.localizedDescription)\n"
    FileHandle.standardError.write(message.data(using: .utf8) ?? Data())
    exit(1)
}

func readLegacyDoc(_ data: Data) throws -> String {
    do {
        let attributed = try NSAttributedString(
            data: data,
            options: [.documentType: NSAttributedString.DocumentType.docFormat],
            documentAttributes: nil
        )
        return attributed.string
    } catch {
        throw ToolError.message("the legacy .doc could not be read")
    }
}

func ocrPDF(_ data: Data) throws -> String {
    guard let document = PDFDocument(data: data) else {
        throw ToolError.message("the PDF could not be opened for OCR")
    }
    let pageLimit = min(document.pageCount, 20)
    var pages: [String] = []
    for index in 0..<pageLimit {
        guard let page = document.page(at: index) else { continue }
        let text = ocrPage(page).trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { pages.append(text) }
    }
    var result = pages.joined(separator: "\n\n")
    if document.pageCount > pageLimit {
        result += (result.isEmpty ? "" : "\n\n") + "[… OCR stopped after \(pageLimit) pages …]"
    }
    return result
}

func ocrPage(_ page: PDFPage) -> String {
    let bounds = page.bounds(for: .mediaBox)
    guard bounds.width > 0, bounds.height > 0 else { return "" }
    let width: CGFloat = 2000
    let size = NSSize(width: width, height: max(1, width * bounds.height / bounds.width))
    let image = page.thumbnail(of: size, for: .mediaBox)
    var rect = CGRect(origin: .zero, size: image.size)
    guard let cgImage = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { return "" }
    // A full-page request loses tiny text on sparse scans; horizontal bands give
    // Vision a readable scale, and row grouping rebuilds lines from word boxes.
    // 整页请求会在稀疏扫描件上丢失小字；横向条带给 Vision 可读的尺度，行重组再把词框拼回行。
    let bandHeight = 1024
    var bands: [String] = []
    var y = 0
    while y < cgImage.height {
        let height = min(bandHeight, cgImage.height - y)
        if let band = cgImage.cropping(to: CGRect(x: 0, y: y, width: cgImage.width, height: height)) {
            let text = recognizeRows(band).trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { bands.append(text) }
        }
        y += bandHeight
    }
    return bands.joined(separator: "\n")
}

func recognizeRows(_ image: CGImage) -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.automaticallyDetectsLanguage = true
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do {
        try handler.perform([request])
    } catch {
        return ""
    }
    let items = (request.results ?? []).compactMap { observation -> TextItem? in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        return TextItem(text: candidate.string, box: observation.boundingBox)
    }
    var rows: [[TextItem]] = []
    for item in items.sorted(by: { $0.box.maxY > $1.box.maxY }) {
        if let last = rows.indices.last, let anchor = rows[last].first, abs(anchor.box.midY - item.box.midY) <= 0.008 {
            rows[last].append(item)
        } else {
            rows.append([item])
        }
    }
    return rows
        .map { row in row.sorted { $0.box.minX < $1.box.minX }.map(\.text).joined(separator: " ") }
        .joined(separator: "\n")
}
