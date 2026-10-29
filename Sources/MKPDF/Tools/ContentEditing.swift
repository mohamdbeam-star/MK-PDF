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
    /// Recognised (OCR) text over a scan or drawing: the visible letters are pixels, not text.
    var scanned = false
    /// The table cell holding the block (between the vertical lines on either side), when it's in one.
    var cell: CGRect? = nil

    /// The width edited text wraps at: the paragraph's width, or for one line in a table cell, the room left in the
    /// cell (so longer text wraps inside it instead of running across the next column). Nil: no wrapping.
    var wrapWidth: CGFloat? {
        if isMultiline { return rect.width + 2 }
        guard let cell else { return nil }
        switch alignment {
        case .right: return rect.maxX - cell.minX - 3
        case .center: return cell.width - 4
        default: return cell.maxX - rect.minX - 3
        }
    }

    var firstBaseline: CGFloat { baselines.first ?? rect.maxY }
    var isMultiline: Bool { lineRects.count > 1 }
}

enum ContentEditor {
    // MARK: - Reading

    static func blocks(on page: PDFPage) -> [TextBlock] {
        guard let ref = page.pageRef else { return [] }
        let content = PageContent(page: ref)
        let baseFonts = Dictionary(content.shows.map { ($0.fontResource, $0.baseFont) }, uniquingKeysWith: { a, _ in a })
        // Text drawn twice on top of itself (a fake bold) is one line of text; editing removes both copies.
        let glyphs = content.glyphsWithoutOverprint.filter { $0.upright && $0.rect.width > 0.05 && $0.size > 0.5 }

        // A table's vertical lines separate cells: text never joins across one.
        let walls = content.rules.filter { $0.height > $0.width * 3 && $0.height > 4 }
        let floors = content.rules.filter { $0.width > $0.height * 3 && $0.width > 4 }
        func walled(_ a: Glyph, _ b: Glyph) -> Bool {
            let x0 = min(a.rect.maxX, b.rect.minX) - 0.5, x1 = max(a.rect.maxX, b.rect.minX) + 0.5, y = (a.rect.midY + b.rect.midY) / 2
            return walls.contains { $0.midX > x0 && $0.midX < x1 && $0.minY <= y && $0.maxY >= y }
        }
        // Glyphs → lines: same baseline, split at column-sized gaps and table rules. Lines are found by position, not
        // drawing order, so text placed glyph by glyph in any order (right-to-left scripts, tables drawn by column)
        // still forms whole lines.
        var lines: [[Glyph]] = []
        var band: [Glyph] = []
        func endBand() {
            var line: [Glyph] = []
            for g in band.sorted(by: { $0.rect.minX < $1.rect.minX }) {
                if let prev = line.last, g.rect.minX - prev.rect.maxX >= max(prev.size, g.size) * 1.1 || walled(prev, g) { lines.append(line); line = [] }
                line.append(g)
            }
            if !line.isEmpty { lines.append(line) }
            band = []
        }
        for g in glyphs.sorted(by: { $0.origin.y > $1.origin.y }) {
            if let first = band.first, abs(g.origin.y - first.origin.y) >= max(1, first.size * 0.25) { endBand() }
            band.append(g)
        }
        endBand()

        struct Line { var rect: CGRect; var baseline: CGFloat; var size: CGFloat; var font: String; var resource: String; var color: CGColor?; var invisible: Bool; var glyphs: [Glyph] }
        let lineInfo: [Line] = lines.compactMap { gs in
            let visible = gs.filter { !content.isBlank($0) }
            guard !visible.isEmpty else { return nil }
            let rect = visible.reduce(CGRect.null) { $0.union($1.rect) }
            let sizes = visible.map(\.size).sorted()
            return Line(rect: rect, baseline: visible[0].origin.y, size: CGFloat(sizes[sizes.count / 2]),
                        font: baseFonts[visible[0].fontResource] ?? "", resource: visible[0].fontResource, color: visible[0].color,
                        invisible: visible.allSatisfy(\.invisible), glyphs: gs)
        }
        func decoded(_ line: Line) -> String? { content.string(of: line.glyphs) }

        // Lines → paragraphs: each line joins the paragraph directly above it when evenly spaced, similar in size and
        // aligned (so columns side by side stay separate paragraphs).
        var groups: [[Line]] = []
        var open: [Int] = []
        for line in lineInfo {
            var best: (index: Int, pitch: CGFloat)?
            for gi in open {
                let block = groups[gi], last = block[block.count - 1]
                let pitch = last.baseline - line.baseline
                let sameSize = abs(line.size - last.size) < max(line.size, last.size) * (line.invisible ? 0.3 : 0.15)
                let spacingOK = pitch > line.size * 0.8 && pitch < line.size * 1.9
                let steady = block.count < 2 || abs(pitch - (block[block.count - 2].baseline - last.baseline)) < line.size * 0.3
                let aligned = abs(line.rect.minX - block[block.count > 1 ? 1 : 0].rect.minX) < line.size * (block.count == 1 ? 3 : 1.2)
                    || abs(line.rect.midX - last.rect.midX) < line.size
                let overlaps = line.rect.minX < last.rect.maxX && line.rect.maxX > last.rect.minX
                    && !floors.contains { $0.midY < last.rect.minY + 0.5 && $0.midY > line.rect.maxY - 0.5 && $0.minX < line.rect.maxX && $0.maxX > line.rect.minX }
                if sameSize && spacingOK && steady && aligned && overlaps && pitch < (best?.pitch ?? .infinity) { best = (gi, pitch) }
            }
            if let best { groups[best.index].append(line) } else { groups.append([line]); open.append(groups.count - 1) }
            // Paragraphs whose last line is far above can't continue.
            open.removeAll { gi in groups[gi][groups[gi].count - 1].baseline - line.baseline > line.size * 2.5 }
            if best == nil, !open.contains(groups.count - 1) { open.append(groups.count - 1) }
        }

        let found = groups.compactMap { group -> TextBlock? in
            var texts: [(text: String, width: CGFloat)] = []
            var attributes: [NSAttributedString.Key: Any] = [:]
            for line in group {
                let own = decoded(line)
                if let own { texts.append((own, line.rect.width)) }
                if own != nil && (!attributes.isEmpty || group[0].color != nil) { continue }
                let probe = line.rect.insetBy(dx: -0.5, dy: line.rect.height * 0.25)
                guard let sel = page.selection(for: probe) else { continue }
                let s = (sel.string ?? "").replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
                if own == nil {
                    // PDFKit's text is only believable when it has about as many letters as the line has glyphs;
                    // otherwise (fonts whose letters have no character codes) the line is read from its rendering.
                    let shown = PageContent.withoutOverprint(line.glyphs.sorted { $0.rect.minX < $1.rect.minX })
                        .filter { !content.isBlank($0) }.count
                    let letters = s.filter { !$0.isWhitespace }.count
                    if !s.isEmpty, abs(letters - shown) <= max(2, shown / 4) { texts.append((s, line.rect.width)) }
                    else if let read = OCR.text(of: page, in: line.rect) { texts.append((read, line.rect.width)) }
                    else if !s.isEmpty { texts.append((s, line.rect.width)) }
                }
                if attributes.isEmpty, let attr = sel.attributedString, attr.length > 0 {
                    let i = (attr.string.firstIndex { !$0.isWhitespace }).map { attr.string.distance(from: attr.string.startIndex, to: $0) } ?? 0
                    attributes = attr.attributes(at: min(i, attr.length - 1), effectiveRange: nil)
                }
            }
            // A line that ends well short of the paragraph's width ended there on purpose (a list, an address, labels):
            // that break is kept, so editing reflows only lines that were wrapped.
            let full = texts.map(\.width).max() ?? 0
            var text = ""
            for (k, t) in texts.enumerated() {
                if k > 0 { text += texts[k - 1].width < full * 0.75 ? "\n" : " " }
                text += t.text
            }
            guard !text.isEmpty else { return nil }
            let size = group[0].size
            let font = FontResolver.font(baseFont: group[0].font, embedded: { content.fontProgram(for: group[0].resource) },
                                         size: size, sample: text)
            let color = group[0].color.flatMap { NSColor(cgColor: $0) } ?? (attributes[.foregroundColor] as? NSColor) ?? .black
            let pitch = group.count > 1 ? (group[0].baseline - group[1].baseline) : size * 1.2
            let rect = group.reduce(CGRect.null) { $0.union($1.rect) }
            let centered = group.count > 1 && group.allSatisfy { abs($0.rect.midX - rect.midX) < size } && !group.allSatisfy { abs($0.rect.minX - rect.minX) < 1 }
            let scanned = group.allSatisfy(\.invisible)
            // The table cell around the block, from the nearest vertical lines on each side.
            var cell: CGRect?
            let sides = walls.filter { $0.minY <= rect.midY && $0.maxY >= rect.midY }
            if let l = sides.filter({ $0.midX <= rect.minX + 1 }).max(by: { $0.midX < $1.midX }),
               let r = sides.filter({ $0.midX >= rect.maxX - 1 }).min(by: { $0.midX < $1.midX }) {
                cell = CGRect(x: l.maxX, y: max(l.minY, r.minY), width: r.minX - l.maxX, height: min(l.maxY, r.maxY) - max(l.minY, r.minY))
            }
            var alignment: NSTextAlignment = centered ? .center : (text.isRightToLeft ? .right : .left)
            if let cell, group.count == 1 {
                // A single line set against the cell's right side (amounts) or in its middle keeps that alignment.
                let left = rect.minX - cell.minX, right = cell.maxX - rect.maxX
                if right < 6 && left > right * 3 { alignment = .right } else if abs(left - right) < 2.5 && left > 6 { alignment = .center }
            }
            return TextBlock(rect: rect, lineRects: group.map(\.rect), baselines: group.map(\.baseline), text: text,
                             font: font, color: scanned ? .black : color, pitch: pitch,
                             alignment: alignment, scanned: scanned, cell: cell)
        }
        // A single line with other text beside it on the same line (a table without vertical lines): the gap up to
        // that text is its cell, so longer text wraps there instead of running into the next column.
        let crop = page.bounds(for: .cropBox)
        return found.map { block -> TextBlock in
            guard !block.isMultiline else { return block }
            var block = block
            // Column alignment: single lines above and below sharing this one's right edge (but not its left edge)
            // make a right-aligned column, like amounts in a table; sharing its centre, a centred one.
            if block.alignment == .left && !block.text.isRightToLeft {
                let column = found.filter { o in !o.isMultiline && o.rect.minY != block.rect.minY && abs(o.rect.midY - block.rect.midY) < 200
                    && o.rect.minX < block.rect.maxX && o.rect.maxX > block.rect.minX }
                let rights = column.filter { abs($0.rect.maxX - block.rect.maxX) < 1.5 && abs($0.rect.minX - block.rect.minX) > 2 }.count
                let centres = column.filter { abs($0.rect.midX - block.rect.midX) < 1.5 && abs($0.rect.minX - block.rect.minX) > 2 }.count
                let lefts = column.filter { abs($0.rect.minX - block.rect.minX) < 1.5 }.count
                if rights >= 2 && rights > lefts { block.alignment = .right } else if centres >= 2 && centres > lefts { block.alignment = .center }
            }
            guard block.cell == nil else { return block }
            let row = found.filter { $0.rect.minY < block.rect.midY && $0.rect.maxY > block.rect.midY }
            let right = row.filter { $0.rect.minX >= block.rect.maxX - 0.5 }.map(\.rect.minX).min()
            let left = row.filter { $0.rect.maxX <= block.rect.minX + 0.5 }.map(\.rect.maxX).max()
            guard right != nil || left != nil else { return block }
            var b = block
            let x0 = (left ?? crop.minX) + 3, x1 = (right ?? crop.maxX) - 3
            b.cell = CGRect(x: x0, y: block.rect.minY, width: max(block.rect.width, x1 - x0), height: block.rect.height)
            return b
        }
    }

    /// The paper and ink colours around a rect of the rendered page (for editing scanned text in place).
    static func sampleColors(on page: PDFPage, around rect: CGRect) -> (paper: NSColor, ink: NSColor) {
        let crop = page.bounds(for: .cropBox), scale: CGFloat = 2
        guard let image = PageRenderer.image(of: page, dpi: 72 * scale) else { return (.white, .black) }
        let area = rect.insetBy(dx: -3, dy: -3)
        let px = CGRect(x: (area.minX - crop.minX) * scale, y: (crop.maxY - area.maxY) * scale, width: area.width * scale, height: area.height * scale)
            .integral.intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard px.width > 4, px.height > 4, let cut = image.cropping(to: px) else { return (.white, .black) }
        let w = cut.width, h = cut.height
        var data = [UInt8](repeating: 0, count: w * h * 4)
        guard let ctx = CGContext(data: &data, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return (.white, .black) }
        ctx.draw(cut, in: CGRect(x: 0, y: 0, width: w, height: h))
        func pixel(_ x: Int, _ y: Int) -> (Double, Double, Double) { let i = (y * w + x) * 4; return (Double(data[i]) / 255, Double(data[i + 1]) / 255, Double(data[i + 2]) / 255) }
        // Paper: the median of the border ring. Ink: the darkest fifth of the pixels that clearly differ from it.
        var ring: [(Double, Double, Double)] = []
        for x in 0..<w { ring.append(pixel(x, 0)); ring.append(pixel(x, h - 1)) }
        for y in 0..<h { ring.append(pixel(0, y)); ring.append(pixel(w - 1, y)) }
        func median(_ v: [Double]) -> Double { let s = v.sorted(); return s[s.count / 2] }
        let paper = (median(ring.map(\.0)), median(ring.map(\.1)), median(ring.map(\.2)))
        var ink: [(Double, Double, Double)] = []
        for y in stride(from: 0, to: h, by: 1) { for x in stride(from: 0, to: w, by: 1) {
            let p = pixel(x, y)
            if abs(p.0 - paper.0) + abs(p.1 - paper.1) + abs(p.2 - paper.2) > 0.6 { ink.append(p) }
        } }
        ink.sort { $0.0 + $0.1 + $0.2 < $1.0 + $1.1 + $1.2 }
        let dark = ink.prefix(max(1, ink.count / 5))
        let color: NSColor = dark.isEmpty ? .black : NSColor(srgbRed: dark.map(\.0).reduce(0, +) / Double(dark.count), green: dark.map(\.1).reduce(0, +) / Double(dark.count),
                                                           blue: dark.map(\.2).reduce(0, +) / Double(dark.count), alpha: 1)
        return (NSColor(srgbRed: paper.0, green: paper.1, blue: paper.2, alpha: 1), color)
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
        // New text is drawn on a separate page and merged into the content, so the rest of the page is never
        // re-drawn (re-drawing turns Type 3 fonts into outlines, which can't be edited any more).
        var data = content.pdfData()
        if let overlay {
            guard let layer = PageFactory.render(mediaBox: page.bounds(for: .mediaBox), overlay), let layerRef = layer.pageRef else { return nil }
            data = content.pdfData(overlay: layerRef)
        }
        guard let data, let result = PDFDocument(data: data)?.page(at: 0) else { return nil }
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
        let chosen = NSFontManager.shared.font(withFamily: family, traits: traits, weight: 5, size: size) ?? .systemFont(ofSize: size)
        if covers(chosen, sample) { return chosen }
        // Text in another script (Arabic, Hebrew, CJK…): the system's font for those letters, in the same weight.
        let cascade = CTFontCreateForString(chosen as CTFont, sample as CFString, CFRange(location: 0, length: (sample as NSString).length)) as NSFont
        return NSFontManager.shared.convert(cascade, toHaveTrait: traits)

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
        // Scanned text is pixels: cover the old line with the paper colour and write in the ink colour.
        var patches: [CGRect] = [], paper = NSColor.white, ink = color
        if let original, original.scanned {
            let sample = ContentEditor.sampleColors(on: page, around: original.rect)
            paper = sample.paper
            if color == original.color { ink = sample.ink }
            // Recognised boxes hug the letters loosely: cover ascenders and descenders generously.
            patches = original.lineRects.map { CGRect(x: $0.minX - 2, y: $0.minY - $0.height * 0.3, width: $0.width + 4, height: $0.height * 1.75) }
        }
        guard let newPage = ContentEditor.rewrite(page, edit: { content in
            guard !rects.isEmpty else { return }
            // The line's glyphs, and the blank spaces just before or after it (otherwise they'd sit among the new letters).
            content.removeGlyphs { g in
                let c = CGPoint(x: g.rect.midX, y: g.rect.midY)
                return g.upright && rects.contains { $0.contains(c) || (content.isBlank(g) && $0.insetBy(dx: -CGFloat(g.size) * 1.5, dy: 0).contains(c)) }
            }
        }, overlay: trimmed.isEmpty && patches.isEmpty ? nil : { ctx in
            if !patches.isEmpty {
                ctx.setFillColor(paper.cgColor)
                patches.forEach { ctx.fill($0) }
            }
            if !trimmed.isEmpty {
                ContentEditor.draw(text, font: font, color: ink, origin: origin, width: width, box: box, pitch: pitch, alignment: alignment, in: ctx)
            }
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
