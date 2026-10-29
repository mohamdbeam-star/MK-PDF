import AppKit
import PDFKit
import Vision
import CoreText

enum OCR {
    struct Line {
        let text: String
        let rect: CGRect // page space
    }

    static func supportedLanguages() -> [String] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        return (try? request.supportedRecognitionLanguages()) ?? ["en-US"]
    }

    /// Recognises text lines on a page rendered at `dpi`.
    static func recognize(_ page: PDFPage, language: String?, accurate: Bool, dpi: CGFloat = 300) throws -> [Line] {
        guard let image = PageRenderer.image(of: page, dpi: dpi, annotations: false) else { return [] }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = accurate ? .accurate : .fast
        request.usesLanguageCorrection = true
        if let language { request.recognitionLanguages = [language] } else { request.automaticallyDetectsLanguage = true }
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        let crop = page.bounds(for: .cropBox)
        return (request.results ?? []).compactMap { obs in
            guard let text = obs.topCandidates(1).first?.string, !text.isEmpty else { return nil }
            let b = obs.boundingBox
            return Line(text: text, rect: CGRect(x: crop.minX + b.minX * crop.width, y: crop.minY + b.minY * crop.height,
                                                 width: b.width * crop.width, height: b.height * crop.height))
        }
    }

    /// The text in one small area of a page (a line whose font doesn't say what its letters are), read from its
    /// rendering at about 40 pixels per line.
    static func text(of page: PDFPage, in rect: CGRect) -> String? {
        let area = rect.insetBy(dx: -2, dy: -rect.height * 0.2)
        let scale = min(12, max(3, 48 / max(rect.height, 1)))
        let w = Int(area.width * scale), h = Int(area.height * scale)
        guard w > 4, h > 4, w * h < 40_000_000,
              let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        ctx.setFillColor(.white)
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.scaleBy(x: scale, y: scale)
        ctx.translateBy(x: -area.minX, y: -area.minY)
        page.draw(with: .mediaBox, to: ctx)
        guard let image = ctx.makeImage() else { return nil }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        request.automaticallyDetectsLanguage = true
        guard (try? VNImageRequestHandler(cgImage: image, options: [:]).perform([request])) != nil else { return nil }
        let parts = (request.results ?? []).sorted { $0.boundingBox.minX < $1.boundingBox.minX }.compactMap { $0.topCandidates(1).first?.string }
        let s = parts.joined(separator: " ").trimmingCharacters(in: .whitespaces)
        return s.isEmpty ? nil : s
    }

    /// Draws `lines` as invisible text, stretched to cover each recognised box, so it can be searched and selected.
    static func drawInvisibleText(_ lines: [Line], in ctx: CGContext) {
        ctx.setTextDrawingMode(.invisible)
        for line in lines where line.rect.width > 1 && line.rect.height > 1 {
            let font = CTFontCreateWithName("Helvetica" as CFString, line.rect.height * 0.85, nil)
            let attributed = NSAttributedString(string: line.text, attributes: [.font: font])
            let ctLine = CTLineCreateWithAttributedString(attributed)
            let width = CTLineGetTypographicBounds(ctLine, nil, nil, nil)
            guard width > 0 else { continue }
            ctx.saveGState()
            ctx.textMatrix = .identity
            ctx.translateBy(x: line.rect.minX, y: line.rect.minY + line.rect.height * 0.18)
            ctx.scaleBy(x: line.rect.width / CGFloat(width), y: 1)
            ctx.textPosition = .zero
            CTLineDraw(ctLine, ctx)
            ctx.restoreGState()
        }
    }
}

extension EditorModel {
    func runOCR(pages: [Int]?, language: String?, accurate: Bool, skipTextPages: Bool) {
        guard let copy = PDFExporter.copy(of: pdf) else { return }
        let targets = (pages ?? Array(0..<copy.pageCount)).filter { i in
            guard let page = copy.page(at: i) else { return false }
            return !skipTextPages || (page.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        guard !targets.isEmpty else {
            return Panels.alert("Nothing to recognize", "All selected pages already contain text.")
        }
        // Rotated scans are made upright first, so recognised lines (and later edits) run the way the page is read.
        for i in targets { if let page = copy.page(at: i), page.rotation % 360 != 0 { copy.replacePage(at: i, with: PageCompositor.upright(page)) } }
        run("Recognizing text…") { progress in
            var results: [(Int, [OCR.Line])] = []
            for (n, i) in targets.enumerated() {
                if let page = copy.page(at: i) {
                    results.append((i, try OCR.recognize(page, language: language, accurate: accurate)))
                }
                progress(Double(n + 1) / Double(targets.count))
            }
            return results
        } then: { results in
            var found = 0
            for (i, lines) in results where !lines.isEmpty {
                guard let page = copy.page(at: i),
                      let composed = PageCompositor.compose(page, overlay: { OCR.drawInvisibleText(lines, in: $0) }) else { continue }
                copy.replacePage(at: i, with: composed)
                found += lines.count
            }
            guard found > 0 else { return Panels.alert("No text found", "The pages didn't contain recognizable text.") }
            self.replaceDocument(with: copy, name: "Recognize Text")
        }
    }
}
