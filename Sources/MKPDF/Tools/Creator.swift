import AppKit
import PDFKit
import WebKit
import UniformTypeIdentifiers

/// Turns files into PDF pages.
enum Combiner {
    static func pages(from urls: [URL], paper: CGSize? = nil) -> [PDFPage] {
        var result: [PDFPage] = []
        for url in urls {
            if url.pathExtension.lowercased() == "pdf" || UTType(filenameExtension: url.pathExtension)?.conforms(to: .pdf) == true {
                guard let doc = PDFDocument(url: url) else { continue }
                if doc.isLocked {
                    guard let pw = Panels.prompt("“\(url.lastPathComponent)” is protected", message: "Enter its password.", secure: true),
                          doc.unlock(withPassword: pw), let data = doc.dataRepresentation(), let open = PDFDocument(data: data) else { continue }
                    result += open.pages
                } else {
                    result += doc.pages
                }
            } else if let image = NSImage(contentsOf: url), let page = PageFactory.page(for: image, paper: paper) {
                result.append(page)
            } else if let page = Creator.document(at: url) {
                result += page.pages
            }
        }
        return result
    }

    static func combine(_ urls: [URL]) -> PDFDocument? {
        let pages = pages(from: urls)
        guard !pages.isEmpty else { return nil }
        let doc = PDFDocument()
        for (i, p) in pages.enumerated() { doc.insert(p, at: i) }
        return doc
    }
}

enum Creator {
    static func blank() {
        DocumentLauncher.open({
            let d = PDFDocument()
            d.insert(PageFactory.blank(size: PageFactory.letter), at: 0)
            return d
        }())
    }

    static func fromImages() {
        let urls = Panels.open(Panels.imageTypes, multiple: true, title: "Choose images — each becomes a page")
        guard !urls.isEmpty else { return }
        let fit = Panels.confirm("Fit images on A4 pages?", message: "Choose “Keep Size” to make each page the size of its image.", ok: "Fit to A4")
        let doc = PDFDocument()
        for (i, p) in Combiner.pages(from: urls, paper: fit ? PageFactory.a4 : nil).enumerated() { doc.insert(p, at: i) }
        if doc.pageCount > 0 { DocumentLauncher.open(doc) }
    }

    static func fromDocument() {
        guard let url = Panels.open(Panels.documentTypes, title: "Choose a text, RTF, Word or web document").first else { return }
        guard let doc = document(at: url) else { return Panels.alert("Couldn't convert \(url.lastPathComponent)") }
        DocumentLauncher.open(doc)
    }

    static func fromClipboard() {
        let pb = NSPasteboard.general
        if let data = pb.data(forType: .pdf), let doc = PDFDocument(data: data) { return DocumentLauncher.open(doc) }
        if let image = NSImage(pasteboard: pb), let page = PageFactory.page(for: image) {
            let doc = PDFDocument()
            doc.insert(page, at: 0)
            return DocumentLauncher.open(doc)
        }
        if let text = pb.string(forType: .string), let doc = paginate(NSAttributedString(string: text, attributes: [.font: NSFont.systemFont(ofSize: 12)])) {
            return DocumentLauncher.open(doc)
        }
        Panels.alert("The clipboard has no image, PDF or text.")
    }

    /// Converts RTF, Word, HTML, ODT or plain text into a paginated PDF.
    static func document(at url: URL) -> PDFDocument? {
        guard let text = try? NSAttributedString(url: url, options: [:], documentAttributes: nil) else { return nil }
        return paginate(text)
    }

    /// Lays styled text out on Letter pages with one-inch margins.
    static func paginate(_ text: NSAttributedString, paper: CGSize = PageFactory.letter) -> PDFDocument? {
        let margin: CGFloat = 72
        let storage = NSTextStorage(attributedString: text)
        let layout = NSLayoutManager()
        storage.addLayoutManager(layout)
        let bodySize = CGSize(width: paper.width - margin * 2, height: paper.height - margin * 2)
        var containers: [NSTextContainer] = []
        repeat {
            let c = NSTextContainer(size: bodySize)
            c.lineFragmentPadding = 0
            layout.addTextContainer(c)
            containers.append(c)
            layout.ensureLayout(for: c)
        } while layout.glyphRange(for: containers.last!).upperBound < layout.numberOfGlyphs && containers.count < 2000

        let data = NSMutableData()
        var box = CGRect(origin: .zero, size: paper)
        guard let consumer = CGDataConsumer(data: data as CFMutableData),
              let ctx = CGContext(consumer: consumer, mediaBox: &box, nil) else { return nil }
        for c in containers {
            ctx.beginPDFPage(nil)
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)
            ctx.translateBy(x: 0, y: paper.height)
            ctx.scaleBy(x: 1, y: -1)
            let range = layout.glyphRange(for: c)
            let origin = CGPoint(x: margin, y: margin)
            layout.drawBackground(forGlyphRange: range, at: origin)
            layout.drawGlyphs(forGlyphRange: range, at: origin)
            NSGraphicsContext.restoreGraphicsState()
            ctx.endPDFPage()
        }
        ctx.closePDF()
        return PDFDocument(data: data as Data)
    }

    static func fromWebPage() {
        guard var address = Panels.prompt("Create PDF from Web Page", placeholder: "https://example.com"), !address.isEmpty else { return }
        if !address.contains("://") { address = "https://" + address }
        guard let url = URL(string: address) else { return }
        WebPDFMaker.make(url) { doc in
            if let doc { DocumentLauncher.open(doc) } else { Panels.alert("Couldn't load \(address)") }
        }
    }
}

/// Loads a page off screen, captures it as one tall PDF page, then slices it onto Letter-width pages.
final class WebPDFMaker: NSObject, WKNavigationDelegate {
    private static var active: Set<WebPDFMaker> = []
    private let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 900, height: 1200))
    private let done: (PDFDocument?) -> Void

    private init(done: @escaping (PDFDocument?) -> Void) {
        self.done = done
        super.init()
        web.navigationDelegate = self
    }

    static func make(_ url: URL, done: @escaping (PDFDocument?) -> Void) {
        let maker = WebPDFMaker(done: done)
        active.insert(maker)
        maker.web.load(URLRequest(url: url))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Give late-loading content a moment.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            webView.createPDF { result in
                let tall = (try? result.get()).flatMap(PDFDocument.init(data:))
                self.finish(tall.flatMap(Self.slice))
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(nil) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(nil) }

    private func finish(_ doc: PDFDocument?) {
        done(doc)
        Self.active.remove(self)
    }

    private static func slice(_ tall: PDFDocument) -> PDFDocument? {
        guard let page = tall.page(at: 0), let ref = page.pageRef else { return tall }
        let full = page.bounds(for: .mediaBox)
        let pageHeight = full.width * 11 / 8.5
        let doc = PDFDocument()
        var top = full.maxY
        while top > full.minY + 1 {
            let box = CGRect(x: full.minX, y: top - pageHeight, width: full.width, height: pageHeight)
            if let p = PageFactory.render(mediaBox: CGRect(origin: .zero, size: box.size), { ctx in
                ctx.clip(to: CGRect(origin: .zero, size: box.size))
                ctx.translateBy(x: -box.minX, y: -box.minY)
                ctx.drawPDFPage(ref)
            }) {
                doc.insert(p, at: doc.pageCount)
            }
            top -= pageHeight
        }
        return doc
    }
}
