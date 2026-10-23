import AppKit
import PDFKit
import Quartz
import UniformTypeIdentifiers

enum ExportFormat {
    case word, rtf, text, html, csv, excel, powerpoint, png, jpeg, tiff, flattened, grayscale, pdfx
}

extension EditorModel {
    func export(_ format: ExportFormat, dpi: CGFloat = 150) {
        let name = documentName
        switch format {
        case .word, .rtf, .html:
            let (type, ext, docType): (UTType, String, NSAttributedString.DocumentType) = {
                switch format {
                case .word: return (UTType("org.openxmlformats.wordprocessingml.document") ?? .data, "docx", .officeOpenXML)
                case .rtf: return (.rtf, "rtf", .rtf)
                default: return (.html, "html", .html)
                }
            }()
            guard let url = Panels.save(name: "\(name).\(ext)", type: type) else { return }
            let text = attributedText()
            do {
                let data = try text.data(from: NSRange(location: 0, length: text.length), documentAttributes: [.documentType: docType])
                try data.write(to: url)
            } catch { Panels.alert("Export failed", error.localizedDescription) }
        case .text:
            guard let url = Panels.save(name: "\(name).txt", type: .plainText) else { return }
            let text = pdf.pages.map { $0.string ?? "" }.joined(separator: "\n\n\u{0C}")
            try? text.write(to: url, atomically: true, encoding: .utf8)
        case .excel, .powerpoint:
            exportOffice(format, ocr: false)
        case .csv:
            guard let url = Panels.save(name: "\(name).csv", type: .commaSeparatedText) else { return }
            try? TableExtractor.csv(from: pdf).write(to: url, atomically: true, encoding: .utf8)
        case .png, .jpeg, .tiff:
            guard let folder = Panels.folder(title: "Choose a folder for the page images") else { return }
            let (type, ext): (UTType, String) = format == .png ? (.png, "png") : format == .jpeg ? (.jpeg, "jpg") : (.tiff, "tiff")
            guard let copy = PDFExporter.copy(of: pdf) else { return }
            run("Exporting images…") { progress in
                for i in 0..<copy.pageCount {
                    guard let page = copy.page(at: i), let image = PageRenderer.image(of: page, dpi: dpi) else { continue }
                    let rotated = image.rotated(by: page.normalizedRotation)
                    let data = format == .jpeg ? PageRenderer.jpegData(rotated, quality: 0.9) : PageRenderer.encode(rotated, type: type)
                    try data?.write(to: folder.appendingPathComponent("\(name)-\(i + 1).\(ext)"))
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
