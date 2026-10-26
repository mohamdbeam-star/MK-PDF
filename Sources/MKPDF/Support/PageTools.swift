import AppKit
import MKPDFCore
import PDFKit
import ImageIO
import UniformTypeIdentifiers

enum PageFactory {
    static let letter = CGSize(width: 612, height: 792)
    static let a4 = CGSize(width: 595, height: 842)

    static func blank(size: CGSize) -> PDFPage {
        render(mediaBox: CGRect(origin: .zero, size: size)) { _ in } ?? PDFPage()
    }

    /// Builds a one-page PDF whose content is drawn by `draw` in page space.
    static func render(mediaBox: CGRect, _ draw: (CGContext) -> Void) -> PDFPage? {
        var box = mediaBox
        let data = NSMutableData()
        guard let consumer = CGDataConsumer(data: data as CFMutableData),
              let ctx = CGContext(consumer: consumer, mediaBox: &box, nil) else { return nil }
        ctx.beginPDFPage(nil)
        draw(ctx)
        ctx.endPDFPage()
        ctx.closePDF()
        return PDFDocument(data: data as Data)?.page(at: 0)
    }

    /// A page showing `image`, sized to the image (72 dpi) or fitted onto `paper` with margins.
    static func page(for image: NSImage, paper: CGSize? = nil) -> PDFPage? {
        guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
        let pixel = CGSize(width: cg.width, height: cg.height)
        let natural = image.size.width > 0 ? image.size : pixel
        guard let paper else {
            return render(mediaBox: CGRect(origin: .zero, size: natural)) { $0.draw(cg, in: CGRect(origin: .zero, size: natural)) }
        }
        let landscape = natural.width > natural.height
        let sheet = landscape ? CGSize(width: paper.height, height: paper.width) : paper
        let area = CGRect(origin: .zero, size: sheet).insetBy(dx: 36, dy: 36)
        let scale = min(area.width / natural.width, area.height / natural.height, 1)
        let size = CGSize(width: natural.width * scale, height: natural.height * scale)
        let rect = CGRect(x: area.midX - size.width / 2, y: area.midY - size.height / 2, width: size.width, height: size.height)
        return render(mediaBox: CGRect(origin: .zero, size: sheet)) { $0.draw(cg, in: rect) }
    }
}

enum PageCompositor {
    /// Rebuilds `page` with its original vector content, then `overlay` drawn on top (page space).
    /// Annotations are carried over unless listed in `burn`, in which case they're drawn into the page.
    static func compose(_ page: PDFPage, burn: [PDFAnnotation] = [], overlay: (CGContext) -> Void) -> PDFPage? {
        guard let ref = page.pageRef else { return nil }
        let media = page.bounds(for: .mediaBox)
        let burnSet = Set(burn.map(ObjectIdentifier.init))
        // The page's own content is kept as it is and the new drawing merged on top. Drawing the page into a new
        // PDF instead would turn Type 3 fonts (Chromium "Save as PDF") into outlines, so its text could no longer
        // be selected or edited. That remains the fallback if the page can't be copied.
        let layer = PageFactory.render(mediaBox: media) { ctx in
            for a in burn {
                ctx.saveGState()
                a.draw(with: .mediaBox, in: ctx)
                ctx.restoreGState()
            }
            ctx.saveGState()
            overlay(ctx)
            ctx.restoreGState()
        }
        if let layerRef = layer?.pageRef,
           let data = PDFWriter.page(from: ref, content: PDFWriter.contentData(of: ref), overlay: layerRef),
           let merged = PDFDocument(data: data)?.page(at: 0) {
            merged.setBounds(page.bounds(for: .cropBox), for: .cropBox)
            merged.rotation = page.rotation
            for a in page.annotations where !burnSet.contains(ObjectIdentifier(a)) && !(a is ImageStampAnnotation) {
                if let copy = a.copy() as? PDFAnnotation { merged.addAnnotation(copy) }
            }
            return merged
        }
        guard let result = PageFactory.render(mediaBox: media, { ctx in
            ctx.saveGState()
            ctx.drawPDFPage(ref)
            ctx.restoreGState()
            for a in burn {
                ctx.saveGState()
                a.draw(with: .mediaBox, in: ctx)
                ctx.restoreGState()
            }
            ctx.saveGState()
            overlay(ctx)
            ctx.restoreGState()
        }) else { return nil }
        result.setBounds(page.bounds(for: .cropBox), for: .cropBox)
        result.rotation = page.rotation
        for a in page.annotations where !burnSet.contains(ObjectIdentifier(a)) && !(a is ImageStampAnnotation) {
            if let copy = a.copy() as? PDFAnnotation { result.addAnnotation(copy) }
        }
        return result
    }

    /// Replaces a page as a flat image (content, annotations and `overlay`), destroying any text under it.
    static func rasterize(_ page: PDFPage, dpi: CGFloat, jpegQuality: CGFloat? = nil, overlay: (CGContext) -> Void = { _ in }) -> PDFPage? {
        guard let image = PageRenderer.image(of: page, dpi: dpi, overlay: overlay) else { return nil }
        var drawable = image
        if let q = jpegQuality, let jpeg = PageRenderer.jpegData(image, quality: q),
           let provider = CGDataProvider(data: jpeg as CFData),
           let decoded = CGImage(jpegDataProviderSource: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent) {
            drawable = decoded // drawn from JPEG data so the PDF keeps the JPEG stream
        }
        let crop = page.bounds(for: .cropBox)
        guard let result = PageFactory.render(mediaBox: crop, { $0.draw(drawable, in: crop) }) else { return nil }
        result.rotation = page.rotation
        return result
    }
}

enum PageRenderer {
    /// Renders the crop box of `page` (unrotated, page space) with its annotations.
    static func image(of page: PDFPage, dpi: CGFloat, annotations: Bool = true, overlay: (CGContext) -> Void = { _ in }) -> CGImage? {
        guard let ref = page.pageRef else { return nil }
        let crop = page.bounds(for: .cropBox)
        let scale = dpi / 72
        let w = max(1, Int((crop.width * scale).rounded())), h = max(1, Int((crop.height * scale).rounded()))
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        ctx.setFillColor(.white)
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.interpolationQuality = .high
        ctx.scaleBy(x: scale, y: scale)
        ctx.translateBy(x: -crop.minX, y: -crop.minY)
        ctx.saveGState()
        ctx.drawPDFPage(ref)
        ctx.restoreGState()
        if annotations {
            for a in page.annotations where a.shouldDisplay {
                ctx.saveGState()
                if let stamp = a as? ImageStampAnnotation { stamp.drawImage(in: ctx) } else { a.draw(with: .mediaBox, in: ctx) }
                ctx.restoreGState()
            }
        }
        overlay(ctx)
        return ctx.makeImage()
    }

    static func jpegData(_ image: CGImage, quality: CGFloat) -> Data? {
        encode(image, type: .jpeg, properties: [kCGImageDestinationLossyCompressionQuality: quality])
    }

    static func encode(_ image: CGImage, type: UTType, properties: [CFString: Any] = [:]) -> Data? {
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data as CFMutableData, type.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, properties as CFDictionary)
        return CGImageDestinationFinalize(dest) ? data as Data : nil
    }
}

extension PDFPage {
    var normalizedRotation: Int { ((rotation % 360) + 360) % 360 }

    /// Page size as it appears on screen (rotation applied).
    var displaySize: CGSize {
        let crop = bounds(for: .cropBox)
        return normalizedRotation % 180 == 0 ? crop.size : CGSize(width: crop.height, height: crop.width)
    }

    /// Maps "display space" (origin at the bottom-left of the page as shown on screen) into page space,
    /// so overlays such as headers stay upright on rotated pages.
    var displayToPage: CGAffineTransform {
        let c = bounds(for: .cropBox)
        let w = c.width, h = c.height
        switch normalizedRotation {
        case 90: return CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: c.minX + w, ty: c.minY)
        case 180: return CGAffineTransform(a: -1, b: 0, c: 0, d: -1, tx: c.minX + w, ty: c.minY + h)
        case 270: return CGAffineTransform(a: 0, b: -1, c: 1, d: 0, tx: c.minX, ty: c.minY + h)
        default: return CGAffineTransform(translationX: c.minX, y: c.minY)
        }
    }
}

extension PDFDocument {
    var pages: [PDFPage] { (0..<pageCount).compactMap { page(at: $0) } }

    /// Every outline item, depth first.
    func outlineItems() -> [PDFOutline] {
        var result: [PDFOutline] = []
        func walk(_ node: PDFOutline) {
            for i in 0..<node.numberOfChildren {
                guard let child = node.child(at: i) else { continue }
                result.append(child)
                walk(child)
            }
        }
        if let root = outlineRoot { walk(root) }
        return result
    }

    /// Swaps the page at `index`, re-pointing bookmarks that targeted the old page.
    func replacePage(at index: Int, with newPage: PDFPage) {
        guard let old = page(at: index) else { return }
        let items = outlineItems().filter { $0.destination?.page === old }
        removePage(at: index)
        insert(newPage, at: index)
        for item in items {
            if let point = item.destination?.point { item.destination = PDFDestination(page: newPage, at: point) }
        }
    }

    /// A new document made of `pages` (each already belonging to no other live document),
    /// keeping this document's metadata.
    func rebuilt(with newPages: [PDFPage]) -> PDFDocument {
        let doc = PDFDocument()
        for (i, p) in newPages.enumerated() { doc.insert(p, at: i) }
        doc.documentAttributes = documentAttributes
        // Carry the bookmarks over, pointing at the matching new page.
        if let root = outlineRoot {
            let newRoot = PDFOutline()
            func copyChildren(_ from: PDFOutline, _ to: PDFOutline) {
                for i in 0..<from.numberOfChildren {
                    guard let child = from.child(at: i) else { continue }
                    let item = PDFOutline()
                    item.label = child.label
                    if let dest = child.destination, let page = dest.page {
                        let idx = index(for: page)
                        if idx != NSNotFound, idx < newPages.count {
                            item.destination = PDFDestination(page: newPages[idx], at: dest.point)
                        }
                    }
                    to.insertChild(item, at: to.numberOfChildren)
                    copyChildren(child, item)
                }
            }
            copyChildren(root, newRoot)
            doc.outlineRoot = newRoot
        }
        return doc
    }
}
