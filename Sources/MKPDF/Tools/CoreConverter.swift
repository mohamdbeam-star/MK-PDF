import AppKit
import JavaScriptCore
import PDFKit
import MKPDFCore

/// Runs the conversion core shared with the Windows and Android apps (`cross/src/core`, bundled as core.js)
/// in JavaScriptCore. The text in any rect of a page is read from the glyphs' fonts (PDFKit where a font doesn't say);
/// pictures are drawn natively on request.
enum CoreConverter {
    struct Failure: LocalizedError { let errorDescription: String? }

    /// core.js: inside the app bundle, or (for development builds) in `cross/dist-core` of the source tree.
    static var scriptURL: URL? {
        if let env = ProcessInfo.processInfo.environment["MKPDF_CORE_JS"] { return URL(fileURLWithPath: env) }
        if let url = Bundle.main.url(forResource: "core", withExtension: "js") { return url }
        var dir = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().deletingLastPathComponent()
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("cross/dist-core/core.js")
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            dir.deleteLastPathComponent()
        }
        return nil
    }

    static var isAvailable: Bool { scriptURL != nil }

    /// A scan's rendering with its recognised (invisible) text lines painted out in the paper colour around each, so
    /// the scan can sit behind the recognised text in Word without showing it twice. Other pages are unchanged.
    static func withoutRecognisedText(_ image: CGImage, page: PDFPage, scale: CGFloat) -> CGImage {
        guard let ref = page.pageRef else { return image }
        let shows = PageContent(page: ref).shows.filter { !$0.glyphs.isEmpty && $0.glyphs.allSatisfy(\.invisible) }
        guard !shows.isEmpty else { return image }
        let w = image.width, h = image.height, crop = page.bounds(for: .cropBox)
        var data = [UInt8](repeating: 0, count: w * h * 4)
        guard let ctx = CGContext(data: &data, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return image }
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        for show in shows {
            let b = show.bounds
            // Recognised boxes hug the letters loosely: cover ascenders and descenders.
            let area = CGRect(x: b.minX - 1.5, y: b.minY - b.height * 0.25, width: b.width + 3, height: b.height * 1.5)
            let px = CGRect(x: (area.minX - crop.minX) * scale, y: (area.minY - crop.minY) * scale, width: area.width * scale, height: area.height * scale)
                .integral.intersection(CGRect(x: 0, y: 0, width: w, height: h))
            guard px.width > 2, px.height > 2 else { continue }
            // Paper: the median of a ring just outside the box (the bitmap's rows run top to bottom).
            var ring: [(UInt8, UInt8, UInt8)] = []
            func sample(_ x: Int, _ yUp: Int) {
                guard x >= 0, x < w, yUp >= 0, yUp < h else { return }
                let o = ((h - 1 - yUp) * w + x) * 4
                ring.append((data[o], data[o + 1], data[o + 2]))
            }
            let x0 = Int(px.minX) - 2, x1 = Int(px.maxX) + 1, y0 = Int(px.minY) - 2, y1 = Int(px.maxY) + 1
            for x in stride(from: x0, through: x1, by: 2) { sample(x, y0); sample(x, y1) }
            for y in stride(from: y0, through: y1, by: 2) { sample(x0, y); sample(x1, y) }
            guard !ring.isEmpty else { continue }
            ring.sort { Int($0.0) + Int($0.1) + Int($0.2) < Int($1.0) + Int($1.1) + Int($1.2) }
            // The lighter half of the ring is paper (the darker part is often a neighbouring table line).
            let paper = ring[min(ring.count - 1, ring.count * 3 / 4)]
            ctx.setFillColor(red: CGFloat(paper.0) / 255, green: CGFloat(paper.1) / 255, blue: CGFloat(paper.2) / 255, alpha: 1)
            ctx.fill(px)
        }
        return ctx.makeImage() ?? image
    }

    /// `format` is one of docx, xlsx, pptx, html, md, txt, csv, rtf.
    static func convert(_ doc: PDFDocument, format: String, title: String) throws -> Data {
        guard let url = scriptURL, let source = try? String(contentsOf: url, encoding: .utf8) else { throw Failure(errorDescription: "The conversion engine is missing from the app.") }
        guard let pdf = doc.dataRepresentation(), let copy = PDFDocument(data: pdf) else { throw Failure(errorDescription: "Couldn't read this PDF.") }
        guard let ctx = JSContext() else { throw Failure(errorDescription: "Couldn't start the conversion engine.") }
        var scriptError: String?
        ctx.exceptionHandler = { _, value in scriptError = value?.toString() }

        var renders: [Int: (CGImage, CGRect, CGFloat)] = [:]
        let render: @convention(block) (Int, Double, Double, Double, Double) -> String? = { index, x, y, w, h in
            guard let page = copy.page(at: index) else { return nil }
            if renders[index] == nil, let img = PageRenderer.image(of: page, dpi: 144) { renders[index] = (Self.withoutRecognisedText(img, page: page, scale: 2), page.bounds(for: .cropBox), 2) }
            guard let (img, crop, scale) = renders[index] else { return nil }
            let r = CGRect(x: (x - crop.minX) * scale, y: (crop.maxY - (y + h)) * scale, width: w * scale, height: h * scale).integral
                .intersection(CGRect(x: 0, y: 0, width: img.width, height: img.height))
            guard r.width >= 2, r.height >= 2, let cut = img.cropping(to: r) else { return nil }
            return NSBitmapImageRep(cgImage: cut).representation(using: .png, properties: [:])?.base64EncodedString()
        }
        let background: @convention(block) (Int, Bool) -> String? = { index, keepText in
            guard let page = copy.page(at: index) else { return nil }
            return TextlessRender.jpeg(page, dpi: 150, keepText: keepText)?.base64EncodedString()
        }
        // The glyphs' own text in a rect; PDFKit's (logical order, with the spaces it infers) where a font doesn't map
        // its codes or the text is right-to-left. PDFKit can place a page's text a little off, so it comes second.
        var contents: [Int: PageContent] = [:]
        let textIn: @convention(block) (Int, Double, Double, Double, Double) -> String? = { index, x, y, w, h in
            guard let page = copy.page(at: index) else { return nil }
            if contents[index] == nil, let ref = page.pageRef { contents[index] = PageContent(page: ref) }
            let rect = CGRect(x: x, y: y, width: w, height: h)
            if let own = contents[index]?.string(in: rect) { return own }
            // PDFKit marks pictures (U+FFFC) and unmapped glyphs with placeholder characters; they're not text.
            let s = String(String.UnicodeScalarView((page.selection(for: rect)?.string ?? "").unicodeScalars.filter { !($0.value == 0xFFFC || $0.value == 0xFFFD || (0xE000...0xF8FF).contains($0.value)) }))
                .replacingOccurrences(of: "\n", with: " ")
            // PDFKit's text is believable when it has about as many letters as there are glyphs; otherwise (fonts whose
            // letters have no character codes) the area is read from its rendering.
            let shown = contents[index]?.glyphsWithoutOverprint.filter { g in
                rect.contains(CGPoint(x: g.rect.midX, y: g.rect.midY)) && !g.invisible && !(contents[index]?.isBlank(g) ?? false)
            }.count ?? 0
            let letters = s.filter { !$0.isWhitespace }.count
            if shown > 0, abs(letters - shown) > max(2, shown / 4), rect.height < 60, let read = OCR.text(of: page, in: rect) { return read }
            return s.isEmpty ? nil : s
        }
        ctx.setObject(textIn, forKeyedSubscript: "nativeTextIn" as NSString)
        // Stacked or transparent pictures: the area as the page shows it, without its text (Word gets the text).
        var arts: [Int: CGImage] = [:]
        let renderArt: @convention(block) (Int, Double, Double, Double, Double) -> String? = { index, x, y, w, h in
            guard let page = copy.page(at: index) else { return nil }
            if arts[index] == nil {
                let source = ContentEditor.rewrite(page, edit: { $0.removeGlyphs { !$0.invisible } }) ?? page
                arts[index] = PageRenderer.image(of: source, dpi: 144, annotations: false)
            }
            guard let img = arts[index] else { return nil }
            let crop = page.bounds(for: .cropBox), scale: CGFloat = 2
            let r = CGRect(x: (x - crop.minX) * scale, y: (crop.maxY - (y + h)) * scale, width: w * scale, height: h * scale).integral
                .intersection(CGRect(x: 0, y: 0, width: img.width, height: img.height))
            guard r.width >= 2, r.height >= 2, let cut = img.cropping(to: r) else { return nil }
            return NSBitmapImageRep(cgImage: cut).representation(using: .png, properties: [:])?.base64EncodedString()
        }
        ctx.setObject(renderArt, forKeyedSubscript: "nativeRenderArt" as NSString)
        ctx.setObject(render, forKeyedSubscript: "nativeRender" as NSString)
        ctx.setObject(background, forKeyedSubscript: "nativeBackground" as NSString)
        let t0 = Date()
        ctx.evaluateScript(source)
        let t1 = Date()
        if let e = scriptError { throw Failure(errorDescription: "Conversion engine error: \(e)") }

        guard let core = ctx.objectForKeyedSubscript("MKPDFCore"), let promise = core.invokeMethod("convert", withArguments: [pdf.base64EncodedString(), "", format, title]) else {
            throw Failure(errorDescription: "Conversion engine error: \(scriptError ?? "not loaded")")
        }
        // Everything inside is synchronous or a microtask, so the promise has settled once the call returns.
        var result: String?, failure: String?
        let done: @convention(block) (JSValue) -> Void = { result = $0.toString() }
        let failed: @convention(block) (JSValue) -> Void = { failure = $0.toString() }
        promise.invokeMethod("then", withArguments: [JSValue(object: done, in: ctx) as Any, JSValue(object: failed, in: ctx) as Any])
        ctx.evaluateScript("void 0") // drains any remaining microtasks
        if ProcessInfo.processInfo.environment["MKPDF_TRACE"] != nil { print(String(format: "core: load %.2fs convert %.2fs", t1.timeIntervalSince(t0), Date().timeIntervalSince(t1))) }
        if let failure { throw Failure(errorDescription: "Conversion failed: \(failure)") }
        guard let result, let data = Data(base64Encoded: result) else { throw Failure(errorDescription: "Conversion failed: \(scriptError ?? "no result")") }
        return data
    }
}
