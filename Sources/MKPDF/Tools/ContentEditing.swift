import AppKit
import PDFKit
import CoreText
import MKPDFCore

/// A paragraph of existing page text, found from glyph positions in the content stream.
struct TextBlock {
    var rect: CGRect            // page space
    var lineRects: [CGRect]
    var baselines: [CGFloat]
    var text: String
    var font: NSFont
    var color: NSColor
    var pitch: CGFloat          // distance between baselines
    var alignment: NSTextAlignment

    var firstBaseline: CGFloat { baselines.first ?? rect.maxY }
    var isMultiline: Bool { lineRects.count > 1 }
}

enum ContentEditor {
    // MARK: - Reading

    static func blocks(on page: PDFPage) -> [TextBlock] {
        guard let ref = page.pageRef else { return [] }
        let content = PageContent(page: ref)
        let baseFonts = Dictionary(content.shows.map { ($0.fontResource, $0.baseFont) }, uniquingKeysWith: { a, _ in a })
        let glyphs = content.glyphs.filter { $0.upright && $0.rect.width > 0.05 && $0.size > 0.5 }

        // Glyphs → lines: same baseline, moving right, no column-sized gap.
        var lines: [[Glyph]] = []
        for g in glyphs {
            if let prev = lines.last?.last,
               abs(g.origin.y - prev.origin.y) < max(1, prev.size * 0.25),
               g.rect.minX >= prev.rect.minX - 0.5,
               g.rect.minX - prev.rect.maxX < max(prev.size, g.size) * 1.1 {
                lines[lines.count - 1].append(g)
            } else {
                lines.append([g])
            }
        }
        // Join fragments drawn separately but sitting on one line.
        var merged = true
        while merged {
            merged = false
            outer: for i in lines.indices {
                for j in lines.indices where i != j {
                    guard let a = lines[i].last, let b = lines[j].first else { continue }
                    if abs(a.origin.y - b.origin.y) < max(1, a.size * 0.25), b.rect.minX >= a.rect.maxX - 1,
                       b.rect.minX - a.rect.maxX < max(a.size, b.size) * 1.1 {
                        lines[i] += lines[j]
                        lines.remove(at: j)
                        merged = true
                        break outer
                    }
                }
            }
        }

        struct Line { var rect: CGRect; var baseline: CGFloat; var size: CGFloat; var font: String; var resource: String; var color: CGColor? }
        let lineInfo: [Line] = lines.compactMap { gs in
            let visible = gs.filter { $0.bytes != Data([32]) && $0.bytes != Data([0, 3]) }
            guard !visible.isEmpty else { return nil }
            let rect = visible.reduce(CGRect.null) { $0.union($1.rect) }
            let sizes = visible.map(\.size).sorted()
            return Line(rect: rect, baseline: visible[0].origin.y, size: CGFloat(sizes[sizes.count / 2]),
                        font: baseFonts[visible[0].fontResource] ?? "", resource: visible[0].fontResource, color: visible[0].color)
        }

        // Lines → paragraphs: evenly spaced, similar size, aligned.
        var groups: [[Line]] = []
        for line in lineInfo {
            if let block = groups.last, let last = block.last {
                let pitch = last.baseline - line.baseline
                let sameSize = abs(line.size - last.size) < max(line.size, last.size) * 0.15
                let spacingOK = pitch > line.size * 0.8 && pitch < line.size * 1.9
                let steady = block.count < 2 || abs(pitch - (block[block.count - 2].baseline - last.baseline)) < line.size * 0.3
                let aligned = abs(line.rect.minX - block[block.count > 1 ? 1 : 0].rect.minX) < line.size * (block.count == 1 ? 3 : 1.2)
                    || abs(line.rect.midX - last.rect.midX) < line.size
                if sameSize && spacingOK && steady && aligned {
                    groups[groups.count - 1].append(line)
                    continue
                }
            }
            groups.append([line])
        }

        return groups.compactMap { group -> TextBlock? in
            var texts: [String] = []
            var attributes: [NSAttributedString.Key: Any] = [:]
            for line in group {
                let probe = line.rect.insetBy(dx: -0.5, dy: line.rect.height * 0.25)
                guard let sel = page.selection(for: probe) else { continue }
                let s = (sel.string ?? "").replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
                if !s.isEmpty { texts.append(s) }
                if attributes.isEmpty, let attr = sel.attributedString, attr.length > 0 {
                    let i = (attr.string.firstIndex { !$0.isWhitespace }).map { attr.string.distance(from: attr.string.startIndex, to: $0) } ?? 0
                    attributes = attr.attributes(at: min(i, attr.length - 1), effectiveRange: nil)
                }
            }
            let text = texts.joined(separator: " ")
            guard !text.isEmpty else { return nil }
            let size = group[0].size
            let font = FontResolver.font(baseFont: group[0].font, embedded: { content.fontProgram(for: group[0].resource) },
                                         size: size, sample: text)
            let color = group[0].color.flatMap { NSColor(cgColor: $0) } ?? (attributes[.foregroundColor] as? NSColor) ?? .black
            let pitch = group.count > 1 ? (group[0].baseline - group[1].baseline) : size * 1.2
            let rect = group.reduce(CGRect.null) { $0.union($1.rect) }
            let centered = group.count > 1 && group.allSatisfy { abs($0.rect.midX - rect.midX) < size } && !group.allSatisfy { abs($0.rect.minX - rect.minX) < 1 }
            return TextBlock(rect: rect, lineRects: group.map(\.rect), baselines: group.map(\.baseline), text: text,
                             font: font, color: color, pitch: pitch,
                             alignment: centered ? .center : (text.isRightToLeft ? .right : .left))
        }
    }

    /// Placed images and drawings that can be moved, resized or deleted.
    static func objects(on page: PDFPage) -> [GraphicObject] {
        guard let ref = page.pageRef else { return [] }
        let crop = page.bounds(for: .cropBox)
        // Skip full-page backgrounds; they're rarely what the user means to grab.
        return PageContent(page: ref).objects.filter { $0.bounds.width > 2 && $0.bounds.height > 2 && !$0.bounds.contains(crop.insetBy(dx: 4, dy: 4)) }
    }

    // MARK: - Writing

    /// Rewrites a page's content with `edit`, then draws `overlay` on top. Annotations are not carried over.
    static func rewrite(_ page: PDFPage, edit: (PageContent) -> Void, overlay: ((CGContext) -> Void)? = nil) -> PDFPage? {
        guard let ref = page.pageRef else { return nil }
        let content = PageContent(page: ref)
        edit(content)
        guard let data = content.pdfData(), let base = PDFDocument(data: data)?.page(at: 0) else { return nil }
        var result = base
        if let overlay {
            guard let composed = PageCompositor.compose(base, overlay: overlay) else { return nil }
            result = composed
        }
        result.setBounds(page.bounds(for: .cropBox), for: .cropBox)
        result.rotation = page.rotation
        return result
    }

    /// Glyph-exact redaction: removes text under `rects`, deletes images entirely inside them and paints black boxes.
    /// Returns nil when an image or drawing only partly overlaps, so the caller can flatten the page instead.
    static func redact(page: PDFPage, rects: [CGRect]) -> PDFPage? {
        guard let ref = page.pageRef else { return nil }
        let probe = PageContent(page: ref)
        for obj in probe.objects where rects.contains(where: { $0.intersects(obj.bounds) }) {
            if !rects.contains(where: { $0.insetBy(dx: -1, dy: -1).contains(obj.bounds) }) { return nil }
        }
        let result = rewrite(page, edit: { content in
            while let obj = content.objects.first(where: { o in rects.contains { $0.insetBy(dx: -1, dy: -1).contains(o.bounds) } }) {
                content.removeObject(obj)
            }
            content.removeGlyphs { g in
                rects.contains { r in
                    let i = r.intersection(g.rect)
                    return !i.isNull && i.width * i.height > g.rect.width * g.rect.height * 0.3
                }
            }
            var ops = [ContentOperation("g", [.number(0)])]
            for r in rects {
                ops.append(ContentOperation("re", [r.minX, r.minY, r.width, r.height].map { .number(Double($0)) }))
            }
            ops.append(ContentOperation("f"))
            content.append(ops)
        })
        if let result {
            for a in page.annotations where !RedactionMark.isMark(a) {
                if let copy = a.copy() as? PDFAnnotation { result.addAnnotation(copy) }
            }
        }
        return result
    }

    /// Draws text line by line starting at `origin` (first baseline), wrapping at `width` when given.
    /// `box` is the width alignment is measured against (defaults to the wrap width, else each line's own width).
    static func draw(_ text: String, font: NSFont, color: NSColor, origin: CGPoint, width: CGFloat?, box: CGFloat? = nil, pitch: CGFloat,
                     alignment: NSTextAlignment, in ctx: CGContext) {
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
        var y = origin.y
        ctx.saveGState()
        ctx.textMatrix = .identity
        for paragraph in text.components(separatedBy: "\n") {
            let attributed = NSAttributedString(string: paragraph, attributes: attrs)
            let length = attributed.length
            guard length > 0 else { y -= pitch; continue }
            let typesetter = CTTypesetterCreateWithAttributedString(attributed)
            var start = 0
            while start < length {
                var count = length - start
                if let width { count = max(1, CTTypesetterSuggestLineBreak(typesetter, start, Double(width))) }
                let line = CTTypesetterCreateLine(typesetter, CFRange(location: start, length: count))
                let lineWidth = CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil) - CTLineGetTrailingWhitespaceWidth(line))
                var x = origin.x
                let box = box ?? width ?? lineWidth
                switch alignment {
                case .center: x += (box - lineWidth) / 2
                case .right: x += box - lineWidth
                default: break
                }
                ctx.textPosition = CGPoint(x: x, y: y)
                CTLineDraw(line, ctx)
                y -= pitch
                start += count
            }
        }
        ctx.restoreGState()
    }
}

/// Finds the best available font for redrawn text.
enum FontResolver {
    private static var embeddedCache: [Data: CTFont] = [:]
    private static var officeIndex: [String: URL]?

    /// Installed original → copy bundled with Microsoft Office → the PDF's embedded font (if it has every
    /// character needed) → the closest system family with the same weight and slant.
    static func font(baseFont: String, embedded: () -> Data?, size: CGFloat, sample: String) -> NSFont {
        let name = baseFont.split(separator: "+").last.map(String.init) ?? baseFont
        if let installed = NSFont(name: name, size: size) { return installed }
        if let url = officeFonts()[name.lowercased()] {
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
            if let f = NSFont(name: name, size: size) { return f }
        }
        if let data = embedded() {
            let ct: CTFont? = embeddedCache[data] ?? {
                guard let desc = CTFontManagerCreateFontDescriptorFromData(data as CFData) else { return nil }
                let f = CTFontCreateWithFontDescriptor(desc, size, nil)
                embeddedCache[data] = f
                return f
            }()
            if let ct, covers(ct as NSFont, sample) { return (ct as NSFont).withSize(size) }
        }
        let lower = name.lowercased()
        var family = "Helvetica Neue"
        if lower.contains("times") || (lower.contains("serif") && !lower.contains("sans")) || lower.contains("georgia")
            || lower.contains("garamond") || lower.contains("cambria") || lower.contains("book") {
            family = "Times New Roman"
        } else if lower.contains("courier") || lower.contains("mono") || lower.contains("consol") {
            family = "Courier New"
        } else if lower.contains("arial") {
            family = "Arial"
        }
        var traits: NSFontTraitMask = []
        if ["bold", "black", "heavy", "semibold", "demi"].contains(where: lower.contains) { traits.insert(.boldFontMask) }
        if lower.contains("italic") || lower.contains("oblique") { traits.insert(.italicFontMask) }
        return NSFontManager.shared.font(withFamily: family, traits: traits, weight: 5, size: size) ?? .systemFont(ofSize: size)
    }

    static func covers(_ font: NSFont, _ text: String) -> Bool {
        let chars = Array(text.filter { !$0.isWhitespace }.utf16)
        guard !chars.isEmpty else { return true }
        var glyphs = [CGGlyph](repeating: 0, count: chars.count)
        return CTFontGetGlyphsForCharacters(font as CTFont, chars, &glyphs, chars.count) && !glyphs.contains(0)
    }

    /// PostScript name → font file for fonts that ship inside Office apps (Calibri, Cambria, …).
    private static func officeFonts() -> [String: URL] {
        if let officeIndex { return officeIndex }
        var index: [String: URL] = [:]
        for app in ["Microsoft Word", "Microsoft Excel", "Microsoft PowerPoint", "Microsoft Outlook"] {
            let dir = URL(fileURLWithPath: "/Applications/\(app).app/Contents/Resources/DFonts")
            for url in (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [] {
                guard ["ttf", "otf", "ttc"].contains(url.pathExtension.lowercased()),
                      let descs = CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor] else { continue }
                for d in descs {
                    if let ps = CTFontDescriptorCopyAttribute(d, kCTFontNameAttribute) as? String, index[ps.lowercased()] == nil {
                        index[ps.lowercased()] = url
                    }
                }
            }
        }
        officeIndex = index
        return index
    }
}

extension String {
    /// True when the first strongly directional character is Arabic or Hebrew.
    var isRightToLeft: Bool {
        for scalar in unicodeScalars {
            switch scalar.value {
            case 0x0590...0x08FF, 0xFB1D...0xFDFF, 0xFE70...0xFEFF: return true
            case 0x41...0x5A, 0x61...0x7A, 0xC0...0x024F: return false
            default: continue
            }
        }
        return false
    }
}

extension EditorModel {
    /// Swaps a page for a rewritten version, moving its annotations across; undo swaps back.
    func swapPage(_ old: PDFPage, with new: PDFPage, name: String) {
        let index = pdf.index(for: old)
        guard index != NSNotFound else { return }
        for a in old.annotations {
            old.removeAnnotation(a)
            new.addAnnotation(a)
        }
        pdf.replacePage(at: index, with: new)
        editObject = nil
        changed()
        undoManager?.registerUndo(withTarget: self) { $0.swapPage(new, with: old, name: name) }
        undoManager?.setActionName(name)
    }

    /// Replaces a text block with new text, style and position, removing the original glyphs from the page.
    func commitTextEdit(page: PDFPage, original: TextBlock?, text: String, font: NSFont, color: NSColor,
                        alignment: NSTextAlignment, at origin: CGPoint, width: CGFloat?, box: CGFloat? = nil) {
        let pitch = original?.pitch ?? font.pointSize * 1.2
        let rects = original?.lineRects.map { $0.insetBy(dx: -0.5, dy: -0.5) } ?? []
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let newPage = ContentEditor.rewrite(page, edit: { content in
            guard !rects.isEmpty else { return }
            content.removeGlyphs { g in
                g.upright && rects.contains { $0.contains(CGPoint(x: g.rect.midX, y: g.rect.midY)) }
            }
        }, overlay: trimmed.isEmpty ? nil : { ctx in
            ContentEditor.draw(text, font: font, color: color, origin: origin, width: width, box: box, pitch: pitch, alignment: alignment, in: ctx)
        }) else {
            return Panels.alert("This text can't be edited", "The page content couldn't be rewritten.")
        }
        swapPage(page, with: newPage, name: original == nil ? "Add Text" : trimmed.isEmpty ? "Delete Text" : "Edit Text")
    }

    func moveObject(_ object: GraphicObject, on page: PDFPage, to rect: CGRect) {
        guard let newPage = ContentEditor.rewrite(page, edit: { content in
            if let match = content.objects.first(where: { $0.opIndex == object.opIndex }) { content.transformObject(match, to: rect) }
        }) else { return }
        swapPage(page, with: newPage, name: "Move Image")
    }

    func deleteObject(_ object: GraphicObject, on page: PDFPage) {
        guard let newPage = ContentEditor.rewrite(page, edit: { content in
            if let match = content.objects.first(where: { $0.opIndex == object.opIndex }) { content.removeObject(match) }
        }) else { return }
        swapPage(page, with: newPage, name: "Delete Image")
    }

    func replaceObject(_ object: GraphicObject, on page: PDFPage) {
        guard let url = Panels.open(Panels.imageTypes, title: "Choose the new image").first,
              let image = NSImage(contentsOf: url) else { return }
        let bounds = object.bounds
        guard let newPage = ContentEditor.rewrite(page, edit: { content in
            if let match = content.objects.first(where: { $0.opIndex == object.opIndex }) { content.removeObject(match) }
        }, overlay: { ctx in
            // Fit inside the old frame, keeping the new image's proportions.
            let s = min(bounds.width / image.size.width, bounds.height / image.size.height)
            let size = CGSize(width: image.size.width * s, height: image.size.height * s)
            let rect = CGRect(x: bounds.midX - size.width / 2, y: bounds.midY - size.height / 2, width: size.width, height: size.height)
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
            image.draw(in: rect)
            NSGraphicsContext.restoreGraphicsState()
        }) else { return }
        swapPage(page, with: newPage, name: "Replace Image")
    }

    func saveObjectImage(_ object: GraphicObject, on page: PDFPage) {
        guard let url = Panels.save(name: "Image.png", type: .png),
              let full = PageRenderer.image(of: page, dpi: 300, annotations: false) else { return }
        let crop = page.bounds(for: .cropBox)
        let s = 300.0 / 72
        let r = object.bounds.intersection(crop)
        let pixel = CGRect(x: (r.minX - crop.minX) * s, y: (crop.maxY - r.maxY) * s, width: r.width * s, height: r.height * s).integral
        guard let cut = full.cropping(to: pixel), let data = PageRenderer.encode(cut, type: .png) else { return }
        try? data.write(to: url)
    }
}
