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
            if renders[index] == nil, let img = PageRenderer.image(of: page, dpi: 144) { renders[index] = (img, page.bounds(for: .cropBox), 2) }
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
            if let own = contents[index]?.string(in: CGRect(x: x, y: y, width: w, height: h)) { return own }
            // PDFKit marks pictures (U+FFFC) and unmapped glyphs with placeholder characters; they're not text.
            guard let s = page.selection(for: CGRect(x: x, y: y, width: w, height: h))?.string else { return nil }
            return String(String.UnicodeScalarView(s.unicodeScalars.filter { !($0.value == 0xFFFC || $0.value == 0xFFFD || (0xE000...0xF8FF).contains($0.value)) }))
                .replacingOccurrences(of: "\n", with: " ")
        }
        ctx.setObject(textIn, forKeyedSubscript: "nativeTextIn" as NSString)
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
