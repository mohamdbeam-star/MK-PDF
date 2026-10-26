import AppKit
import PDFKit
import Quartz
import UniformTypeIdentifiers

enum ExportFormat {
    case word, word97, odt, rtf, text, markdown, html, csv, excel, powerpoint
    case png, jpeg, tiff, heic, webp, bmp, gif
    case flattened, grayscale, pdfx

    var fileExtension: String {
        switch self {
        case .word: return "docx"
        case .word97: return "doc"
        case .odt: return "odt"
        case .rtf: return "rtf"
        case .text: return "txt"
        case .markdown: return "md"
        case .html: return "html"
        case .csv: return "csv"
        case .excel: return "xlsx"
        case .powerpoint: return "pptx"
        case .png: return "png"
        case .jpeg: return "jpg"
        case .tiff: return "tiff"
        case .heic: return "heic"
        case .webp: return "webp"
        case .bmp: return "bmp"
        case .gif: return "gif"
        default: return "pdf"
        }
    }

    var type: UTType {
        UTType(filenameExtension: fileExtension) ?? .data
    }

    var isImage: Bool { [.png, .jpeg, .tiff, .heic, .webp, .bmp, .gif].contains(self) }

    /// The shared conversion core's name for this format, if it writes it.
    private var coreFormat: String? {
        switch self {
        case .word, .word97, .odt: return "docx"
        case .excel: return "xlsx"
        case .powerpoint: return "pptx"
        case .html: return "html"
        case .markdown: return "md"
        case .text: return "txt"
        case .csv: return "csv"
        case .rtf: return "rtf"
        default: return nil
        }
    }

    /// Document formats. Written by the conversion core shared with Windows and Android (same results on every
    /// platform); the native writers below remain as a fallback.
    func render(_ doc: PDFDocument, title: String, progress: (Double) -> Void = { _ in }) throws -> Data {
        if let format = coreFormat, CoreConverter.isAvailable {
            do {
                let data = try CoreConverter.convert(doc, format: format, title: title)
                progress(1)
                guard self == .word97 || self == .odt else { return data }
                // Older Word and OpenDocument: converted from the Word file by the system's text system.
                let text = try NSAttributedString(data: data, options: [.documentType: NSAttributedString.DocumentType.officeOpenXML], documentAttributes: nil)
                return try text.data(from: NSRange(location: 0, length: text.length),
                                     documentAttributes: [.documentType: self == .word97 ? NSAttributedString.DocumentType.docFormat : .openDocument])
            } catch {
                NSLog("MK PDF: conversion core failed (%@), using the built-in writer", error.localizedDescription)
            }
        }
        return try renderNative(doc, title: title, progress: progress)
    }

    private func renderNative(_ doc: PDFDocument, title: String, progress: (Double) -> Void) throws -> Data {
        let layouts = LayoutExtractor.layout(doc, includeImages: [.word, .markdown].contains(self))
        progress(0.5)
        switch self {
        case .word: return DocxWriter.data(layouts)
        case .powerpoint: return PptxWriter.data(layouts, progress: { progress(0.5 + $0 / 2) })
        case .html: return HtmlWriter.data(layouts, title: title)
        case .excel: return XlsxWriter.data(layouts)
        case .text: return Data(TextWriters.plainText(layouts).utf8)
        case .markdown: return Data(TextWriters.markdown(layouts).utf8)
        case .csv:
            let rows = layouts.flatMap { l in l.items.flatMap { item -> [[String]] in
                switch item {
                case .paragraph(let p): return [[p.text]]
                case .table(let t): return t.rows.map { $0.map { $0?.text ?? "" } }
                case .image: return []
                }
            } }
            return Data(rows.map { $0.map { "\"\($0.replacingOccurrences(of: "\"", with: "\"\""))\"" }.joined(separator: ",") }.joined(separator: "\n").utf8)
        case .rtf, .word97, .odt:
            let text = TextWriters.attributed(layouts)
            let type: NSAttributedString.DocumentType = self == .rtf ? .rtf : self == .word97 ? .docFormat : .openDocument
            return try text.data(from: NSRange(location: 0, length: text.length), documentAttributes: [.documentType: type])
        default:
            throw PDFExporter.ExportError()
        }
    }
}

struct ExportError: LocalizedError {
    let errorDescription: String?
}

extension EditorModel {
    /// JPEG/HEIC/WebP quality used by image exports (0…1).
    var imageQuality: CGFloat {
        get { CGFloat(UserDefaults.standard.object(forKey: "imageQuality") as? Double ?? 0.9) }
        set { UserDefaults.standard.set(Double(newValue), forKey: "imageQuality") }
    }

    func export(_ format: ExportFormat, dpi: CGFloat = 150) {
        let name = documentName
        switch format {
        case .word, .word97, .odt, .rtf, .text, .markdown, .html, .csv, .excel, .powerpoint:
            exportOffice(format, ocr: false)
        case .png, .jpeg, .tiff, .heic, .webp, .bmp, .gif:
            guard let folder = Panels.folder(title: "Choose a folder for the page images") else { return }
            guard let copy = PDFExporter.copy(of: pdf) else { return }
            let ext = format.fileExtension, type = format.type
            let quality = imageQuality
            run("Exporting images…") { progress in
                for i in 0..<copy.pageCount {
                    guard let page = copy.page(at: i), let image = PageRenderer.image(of: page, dpi: dpi) else { continue }
                    let rotated = image.rotated(by: page.normalizedRotation)
                    let lossy = [ExportFormat.jpeg, .heic, .webp].contains(format)
                    let data = PageRenderer.encode(rotated, type: type, properties: lossy ? [kCGImageDestinationLossyCompressionQuality: quality] : [:])
                    guard let data else { throw ExportError(errorDescription: "This Mac can't write \(ext.uppercased()) images.") }
                    try data.write(to: folder.appendingPathComponent("\(name)-\(i + 1).\(ext)"))
                    progress(Double(i + 1) / Double(copy.pageCount))
                }
            } then: { NSWorkspace.shared.activateFileViewerSelecting([folder]) }
        case .flattened:
            guard let url = Panels.save(name: "\(name) (flattened).pdf", type: .pdf) else { return }
            do { try PDFExporter.data(for: pdf, extraOptions: [.burnInAnnotationsOption: true]).write(to: url) }
            catch { Panels.alert("Export failed", error.localizedDescription) }
        case .grayscale, .pdfx:
            let filterName = format == .grayscale ? "Gray Tone" : "Create Generic PDFX-3 Document"
            guard let filter = QuartzFilter(url: URL(fileURLWithPath: "/System/Library/Filters/\(filterName).qfilter")) else {
                return Panels.alert("This export isn't available on this Mac.")
            }
            guard let url = Panels.save(name: "\(name) (\(format == .grayscale ? "grayscale" : "PDF-X")).pdf", type: .pdf) else { return }
            do { try PDFExporter.data(for: pdf, extraOptions: [PDFDocumentWriteOption(rawValue: "QuartzFilter"): filter]).write(to: url) }
            catch { Panels.alert("Export failed", error.localizedDescription) }
        }
    }

    /// The document's styled text with page breaks between pages.
    func attributedText() -> NSAttributedString {
        let result = NSMutableAttributedString()
        for (i, page) in pdf.pages.enumerated() {
            if i > 0 { result.append(NSAttributedString(string: "\u{0C}")) }
            if let text = page.attributedString { result.append(text) }
        }
        return result
    }
}

extension CGImage {
    func rotated(by degrees: Int) -> CGImage {
        guard degrees % 360 != 0 else { return self }
        let swap = degrees % 180 != 0
        let w = swap ? height : width, h = swap ? width : height
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return self }
        ctx.translateBy(x: CGFloat(w) / 2, y: CGFloat(h) / 2)
        ctx.rotate(by: -CGFloat(degrees) * .pi / 180)
        ctx.draw(self, in: CGRect(x: -CGFloat(width) / 2, y: -CGFloat(height) / 2, width: CGFloat(width), height: CGFloat(height)))
        return ctx.makeImage() ?? self
    }
}

/// Rebuilds rows and columns from character positions, for CSV export.
enum TableExtractor {
    static func csv(from pdf: PDFDocument) -> String {
        var rows: [String] = []
        for page in pdf.pages {
            guard let all = page.selection(for: page.bounds(for: .cropBox)) else { continue }
            for line in all.selectionsByLine() {
                guard let text = line.string, !text.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
                // Two or more spaces (or tabs) separate columns.
                let cells = text.components(separatedBy: .newlines).joined(separator: " ")
                    .replacingOccurrences(of: "\t", with: "  ")
                    .components(separatedBy: "  ").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                rows.append(cells.map { "\"\($0.replacingOccurrences(of: "\"", with: "\"\""))\"" }.joined(separator: ","))
            }
        }
        return rows.joined(separator: "\n")
    }
}
