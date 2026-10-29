import AppKit
import PDFKit
import Vision
import CoreText

enum OCR {
    struct Line {
        let text: String
        let rect: CGRect // page space
        var confidence: Float = 1
        /// Much taller than the page's other lines and in coloured ink: handwriting (a signature, a note in pen).
        var handwritten = false
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
        var lines: [Line] = (request.results ?? []).compactMap { obs in
            guard let best = obs.topCandidates(1).first, !best.string.isEmpty else { return nil }
            let b = obs.boundingBox
            // Shapes read as letters with little confidence (a logo, a stamp's border) aren't text.
            guard best.confidence >= 0.4 else { return nil }
            return Line(text: best.string, rect: CGRect(x: crop.minX + b.minX * crop.width, y: crop.minY + b.minY * crop.height,
                                                        width: b.width * crop.width, height: b.height * crop.height), confidence: best.confidence)
        }
        let heights = lines.map(\.rect.height).sorted()
        guard let typical = heights.isEmpty ? nil : heights[heights.count / 2] else { return lines }
        for k in lines.indices where lines[k].rect.height > typical * 1.8 {
            lines[k].handwritten = inkSaturation(image, box: lines[k].rect, crop: crop) > 0.3
        }
        return lines
    }

    /// How coloured the ink in a box is (0 for black or grey, near 1 for blue or red pen).
    private static func inkSaturation(_ image: CGImage, box: CGRect, crop: CGRect) -> Double {
        let sx = CGFloat(image.width) / crop.width, sy = CGFloat(image.height) / crop.height
        let r = CGRect(x: (box.minX - crop.minX) * sx, y: (crop.maxY - box.maxY) * sy, width: box.width * sx, height: box.height * sy)
            .integral.intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard r.width > 2, r.height > 2, let cut = image.cropping(to: r) else { return 0 }
        let w = cut.width, h = cut.height
        var data = [UInt8](repeating: 0, count: w * h * 4)
        guard let ctx = CGContext(data: &data, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return 0 }
        ctx.draw(cut, in: CGRect(x: 0, y: 0, width: w, height: h))
        var total = 0.0, n = 0
        for o in stride(from: 0, to: data.count, by: 4) {
            let c = [Double(data[o]), Double(data[o + 1]), Double(data[o + 2])].map { $0 / 255 }
            let hi = c.max()!, lo = c.min()!
            guard (c[0] + c[1] + c[2]) / 3 < 0.6 else { continue } // ink only
            total += hi > 0 ? (hi - lo) / hi : 0
            n += 1
        }
        return n > 20 ? total / Double(n) : 0
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
            // The size that fills the recognised width: boxes are taller or shorter with brackets and descenders,
            // but the width of a line of text follows its size closely.
            let unit = CTLineCreateWithAttributedString(NSAttributedString(string: line.text, attributes: [.font: CTFontCreateWithName("Helvetica" as CFString, 1, nil)]))
            let perPoint = CTLineGetTypographicBounds(unit, nil, nil, nil)
            let fitted = perPoint > 0 ? line.rect.width / CGFloat(perPoint) : line.rect.height * 0.85
            let font = CTFontCreateWithName("Helvetica" as CFString, min(line.rect.height * 0.9, max(line.rect.height * 0.5, fitted)), nil)
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
