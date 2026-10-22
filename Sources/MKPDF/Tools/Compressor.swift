import AppKit
import PDFKit
import Quartz

enum Compressor {
    enum Preset: String, CaseIterable, Identifiable {
        case light, balanced, strong, maximum
        var id: String { rawValue }

        var title: String {
            switch self {
            case .light: return "Light — keep image quality"
            case .balanced: return "Balanced (recommended)"
            case .strong: return "Strong — smaller images"
            case .maximum: return "Maximum — flatten pages to images"
            }
        }

        var detail: String {
            switch self {
            case .light: return "Re-encodes images as JPEG. Text and vectors are untouched."
            case .balanced: return "JPEG images optimized for screen. Text stays selectable."
            case .strong: return "Applies the system file-size filter. Text stays selectable; images get noticeably softer."
            case .maximum: return "Every page becomes a 110 dpi JPEG. Smallest file; text is no longer selectable until you run OCR."
            }
        }
    }

    static func compressedData(_ pdf: PDFDocument, preset: Preset, progress: (Double) -> Void = { _ in }) throws -> Data {
        switch preset {
        case .light:
            return try PDFExporter.data(for: pdf, extraOptions: [.saveImagesAsJPEGOption: true])
        case .balanced:
            return try PDFExporter.data(for: pdf, extraOptions: [.saveImagesAsJPEGOption: true, .optimizeImagesForScreenOption: true])
        case .strong:
            let url = URL(fileURLWithPath: "/System/Library/Filters/Reduce File Size.qfilter")
            guard let filter = QuartzFilter(url: url) else {
                return try compressedData(pdf, preset: .balanced)
            }
            return try PDFExporter.data(for: pdf, extraOptions: [PDFDocumentWriteOption(rawValue: "QuartzFilter"): filter])
        case .maximum:
            guard let copy = PDFExporter.copy(of: pdf) else { throw PDFExporter.ExportError() }
            for i in 0..<copy.pageCount {
                if let page = copy.page(at: i), let flat = PageCompositor.rasterize(page, dpi: 110, jpegQuality: 0.6) {
                    copy.replacePage(at: i, with: flat)
                }
                progress(Double(i + 1) / Double(copy.pageCount))
            }
            guard let data = copy.dataRepresentation() else { throw PDFExporter.ExportError() }
            return data
        }
    }
}

extension EditorModel {
    func compress(_ preset: Compressor.Preset) {
        let before = (try? PDFExporter.data(for: pdf))?.count ?? 0
        let source = pdf
        run("Compressing…") { progress in
            try Compressor.compressedData(source, preset: preset, progress: progress)
        } then: { data in
            guard data.count < before else {
                return Panels.alert("Already optimized", "This preset wouldn't make the file smaller.")
            }
            guard let doc = PDFDocument(data: data) else { return }
            self.replaceDocument(with: doc, name: "Compress")
            let fmt: (Int) -> String = { ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .file) }
            Panels.alert("Compressed", "\(fmt(before)) → \(fmt(data.count)). Save to keep the smaller file.")
        }
    }
}
