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
