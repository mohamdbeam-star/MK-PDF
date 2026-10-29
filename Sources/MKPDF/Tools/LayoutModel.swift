import AppKit
import PDFKit
import MKPDFCore

// A structured reading of a page — paragraphs of styled runs, tables and images, in reading order —
// built from glyph positions. Every document export (Word, PowerPoint, HTML, Excel, RTF, Markdown,
// text) is written from this, so they all share the same layout recovery.

struct LayoutFont: Hashable {
    var family: String
    var postScript: String
    var bold: Bool
    var italic: Bool
    var monospaced: Bool

    /// Interprets a PDF BaseFont such as "ABCDEF+Calibri-BoldItalic" or "TimesNewRomanPS-BoldMT".
    init(baseFont: String) {
        let name = baseFont.split(separator: "+").last.map(String.init) ?? baseFont
        postScript = name
        let lower = name.lowercased()
        bold = ["bold", "black", "heavy", "semibold", "demi"].contains(where: lower.contains)
        italic = lower.contains("italic") || lower.contains("oblique")
        monospaced = lower.contains("courier") || lower.contains("mono") || lower.contains("consol")
        if let installed = NSFont(name: name, size: 12)?.familyName {
            family = installed
            return
        }
        let known: [String: String] = [
            "arialmt": "Arial", "arial": "Arial", "timesnewromanps": "Times New Roman", "timesnewroman": "Times New Roman",
            "times": "Times New Roman", "couriernewps": "Courier New", "couriernew": "Courier New", "courier": "Courier New",
            "helvetica": "Helvetica", "helveticaneue": "Helvetica Neue", "symbolmt": "Symbol", "georgia": "Georgia",
            "verdana": "Verdana", "tahoma": "Tahoma", "calibri": "Calibri", "cambria": "Cambria", "segoeui": "Segoe UI",
        ]
        var stem = String(name.split(separator: "-").first ?? Substring(name))
        for suffix in ["PSMT", "MT", "PS", ",Bold", ",Italic"] where stem.hasSuffix(suffix) { stem.removeLast(suffix.count) }
        if let k = known[stem.lowercased()] {
            family = k
        } else {
            // "OpenSansCondensed" → "Open Sans Condensed"
            var spaced = ""
            for (i, ch) in stem.enumerated() {
                if i > 0, ch.isUppercase, let prev = spaced.last, prev.isLowercase { spaced.append(" ") }
                spaced.append(ch)
            }
            family = spaced.isEmpty ? "Helvetica" : spaced
        }
    }

    /// A Mac font for the run (installed family with the right traits, else a close system font).
    func nsFont(size: CGFloat) -> NSFont {
        var traits: NSFontTraitMask = []
        if bold { traits.insert(.boldFontMask) }
        if italic { traits.insert(.italicFontMask) }
        if let f = NSFont(name: postScript, size: size) { return f }
        if let f = NSFontManager.shared.font(withFamily: family, traits: traits, weight: 5, size: size) { return f }
        let fallback = monospaced ? "Courier New" : family.lowercased().contains("times") || family.lowercased().contains("serif") ? "Times New Roman" : "Helvetica Neue"
        return NSFontManager.shared.font(withFamily: fallback, traits: traits, weight: 5, size: size) ?? .systemFont(ofSize: size)
    }
}

struct LayoutRun {
    var text: String
    var font: LayoutFont
    var size: CGFloat
    var color: NSColor
    var invisible = false
}

struct LayoutLine {
    var rect: CGRect        // page space
    var baseline: CGFloat
    var runs: [LayoutRun]
    /// For a line made of separate pieces on one baseline ("Date …    Quote No …"): the pieces, and the
    /// x position each one after the first starts at (runs then contain a tab between pieces).
    var parts: [LayoutLine] = []
    var tabStops: [CGFloat] = []
    /// The pieces to place individually (the line itself when it isn't split).
    var pieces: [LayoutLine] { parts.isEmpty ? [self] : parts }
    var text: String { runs.map(\.text).joined() }
    var size: CGFloat { runs.map(\.size).max() ?? 12 }
}

struct LayoutParagraph {
    var rect: CGRect
    var lines: [LayoutLine]
    var alignment: NSTextAlignment
    var rightToLeft: Bool
    var pitch: CGFloat
    var size: CGFloat { lines.first?.size ?? 12 }

    /// Lines joined for reflowing editors (hyphenated breaks are closed up).
    var runs: [LayoutRun] {
        var out: [LayoutRun] = []
        for (i, line) in lines.enumerated() {
            var lineRuns = line.runs
            if i < lines.count - 1, var last = lineRuns.last {
                if last.text.hasSuffix("-") { last.text.removeLast() } else if !last.text.hasSuffix(" ") { last.text += " " }
                lineRuns[lineRuns.count - 1] = last
            }
            out += lineRuns
        }
        // Merge neighbours with the same style.
        var merged: [LayoutRun] = []
        for r in out {
            if let l = merged.last, l.font == r.font, abs(l.size - r.size) < 0.25, l.color == r.color, l.invisible == r.invisible {
                merged[merged.count - 1].text += r.text
            } else { merged.append(r) }
        }
        return merged
    }
    var text: String { runs.map(\.text).joined() }
}

struct LayoutTable {
    var rect: CGRect
    var columns: [CGFloat]      // left edge of each column (page space)
    var right: CGFloat
    var rows: [[LayoutLine?]]   // cell lines per column
    var rowRects: [CGRect]
    /// Drawn with ruling lines in the PDF.
    var bordered = false
}

struct LayoutImage {
    var rect: CGRect
    var data: Data
    var ext: String             // "jpeg" or "png"
    var pixelSize: CGSize
}

enum LayoutItem {
    case paragraph(LayoutParagraph)
    case table(LayoutTable)
    case image(LayoutImage)

    var rect: CGRect {
        switch self {
        case .paragraph(let p): return p.rect
        case .table(let t): return t.rect
        case .image(let i): return i.rect
        }
    }
}

struct PageLayout {
    let page: PDFPage
    var items: [LayoutItem]

    var size: CGSize { page.displaySize }

    /// A page-space rect in display space with a top-left origin (what Office and HTML use).
    func topLeft(_ r: CGRect) -> CGRect {
        let d = r.applying(page.displayToPage.inverted())
        return CGRect(x: d.minX, y: size.height - d.maxY, width: d.width, height: d.height)
    }

    /// Area holding all content.
    var contentBounds: CGRect {
        items.reduce(CGRect.null) { $0.union(topLeft($1.rect)) }
    }

    /// Area holding text, for margins (images are positioned on their own).
    var textBounds: CGRect {
        items.reduce(CGRect.null) { r, item in
            if case .image = item { return r }
            return r.union(topLeft(item.rect))
        }
    }
}

enum LayoutExtractor {
    static func layout(_ pdf: PDFDocument, includeImages: Bool = true) -> [PageLayout] {
        pdf.pages.map { layout(of: $0, includeImages: includeImages) }
    }

    static func layout(of page: PDFPage, includeImages: Bool = true) -> PageLayout {
        guard let ref = page.pageRef else { return PageLayout(page: page, items: []) }
        let content = PageContent(page: ref)
        let baseFonts = Dictionary(content.shows.map { ($0.fontResource, $0.baseFont) }, uniquingKeysWith: { a, _ in a })
        let glyphs = content.glyphs.filter { $0.upright && $0.size > 0.5 && $0.rect.width > 0.01 }
        func isSpace(_ g: Glyph) -> Bool { content.isBlank(g) }

        // 1. Rows by baseline, split into segments at column-sized gaps or runs of 3+ spaces.
        let sorted = glyphs.sorted { abs($0.origin.y - $1.origin.y) > max(1, $0.size * 0.3) ? $0.origin.y > $1.origin.y : $0.rect.minX < $1.rect.minX }
        var rows: [[[Glyph]]] = []
        var row: [[Glyph]] = []
        var segment: [Glyph] = []
        var baseline: CGFloat?
        var spaces = 0
        func endSegment() {
            while let last = segment.last, isSpace(last) { segment.removeLast() }
            while let first = segment.first, isSpace(first) { segment.removeFirst() }
            if !segment.isEmpty { row.append(segment) }
            segment = []
        }
        func endRow() {
            endSegment()
            if !row.isEmpty { rows.append(row) }
            row = []
        }
        for g in sorted {
            if let b = baseline, abs(g.origin.y - b) > max(1, g.size * 0.3) { endRow(); baseline = nil; spaces = 0 }
            if baseline == nil { baseline = g.origin.y }
            if isSpace(g) {
                spaces += 1
                if spaces == 3 { endSegment() }
                if !segment.isEmpty { segment.append(g) }
                continue
            }
            if let last = segment.last(where: { !isSpace($0) }), g.rect.minX - last.rect.maxX > max(g.size, last.size) * 1.6 { endSegment() }
            spaces = 0
            segment.append(g)
        }
        endRow()

        func line(_ seg: [Glyph]) -> LayoutLine? {
            let visible = seg.filter { !isSpace($0) }
            guard !visible.isEmpty else { return nil }
            let rect = visible.reduce(CGRect.null) { $0.union($1.rect) }
            let probe = rect.insetBy(dx: -0.3, dy: rect.height * 0.25)
            let text = (page.selection(for: probe)?.string ?? "").replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
            guard !text.isEmpty else { return nil }
            // Style runs: split the text by glyph counts when they line up with the characters.
            struct Style: Equatable { var res: String; var size: Int; var color: CGColor?; var invisible: Bool }
            func style(_ g: Glyph) -> Style { Style(res: g.fontResource, size: Int((g.size * 4).rounded()), color: g.color, invisible: g.invisible) }
            var groups: [(Style, Int)] = []
            for g in visible {
                let s = style(g)
                if let last = groups.last, last.0 == s { groups[groups.count - 1].1 += 1 } else { groups.append((s, 1)) }
            }
            func run(_ s: Style, _ t: String) -> LayoutRun {
                LayoutRun(text: t, font: LayoutFont(baseFont: baseFonts[s.res] ?? "Helvetica"), size: CGFloat(s.size) / 4,
                          color: s.color.flatMap { NSColor(cgColor: $0) } ?? .black, invisible: s.invisible)
            }
            var runs: [LayoutRun] = []
            let chars = Array(text)
            if groups.count > 1, chars.filter({ !$0.isWhitespace }).count == visible.count {
                var gi = 0, used = 0, current = ""
                for ch in chars {
                    current.append(ch)
                    if ch.isWhitespace { continue }
                    used += 1
                    if used == groups[gi].1, gi < groups.count - 1 {
                        runs.append(run(groups[gi].0, current))
                        current = ""
                        gi += 1
                        used = 0
                    }
                }
                runs.append(run(groups[gi].0, current))
            } else {
                let dominant = groups.max { $0.1 < $1.1 }!.0
                runs = [run(dominant, text)]
            }
            return LayoutLine(rect: rect, baseline: visible[0].origin.y, runs: runs)
        }
        let lineRows: [[LayoutLine]] = rows.map { $0.compactMap(line) }.filter { !$0.isEmpty }

        // 2. Tables: two or more consecutive rows that each have two or more segments.
        var items: [LayoutItem] = []
        var free: [LayoutLine] = []
        var i = 0
        while i < lineRows.count {
            var j = i
            while j < lineRows.count, lineRows[j].count >= 2,
                  j == i || abs(lineRows[j - 1][0].baseline - lineRows[j][0].baseline) < lineRows[j][0].size * 3.2 { j += 1 }
            if j - i >= 2 {
                var rowsIn = Array(lineRows[i..<j])
                // Wrapped cell text: following one-segment rows aligned with a later column join that cell.
                var t = table(rowsIn)
                while j < lineRows.count, lineRows[j].count == 1, let l = lineRows[j].first,
                      let last = rowsIn.last?.first, last.baseline - l.baseline < l.size * 1.7,
                      let col = t.columns.lastIndex(where: { $0 <= l.rect.minX + 8 }), col > 0 || abs(l.rect.minX - t.columns[0]) < 8 {
                    rowsIn.append(lineRows[j])
                    if var cell = t.rows[t.rows.count - 1][col] {
                        cell.runs += [LayoutRun(text: " ", font: cell.runs.last!.font, size: cell.size, color: .black)] + l.runs
                        cell.rect = cell.rect.union(l.rect)
                        t.rows[t.rows.count - 1][col] = cell
                    } else { t.rows[t.rows.count - 1][col] = l }
                    t.rect = t.rect.union(l.rect)
                    t.rowRects[t.rowRects.count - 1] = t.rowRects[t.rowRects.count - 1].union(l.rect)
                    j += 1
                }
                let zone = t.rect.insetBy(dx: -6, dy: -8)
                t.bordered = content.rules.filter { zone.intersects($0) && $0.width > $0.height }.count >= 2
                items.append(.table(t))
                i = j
            } else {
                free += lineRows[i]
                i += 1
            }
        }

        // 3. Paragraphs from the remaining lines (top to bottom). Pieces sharing a baseline become one tabbed line.
        free.sort { abs($0.baseline - $1.baseline) > 1 ? $0.baseline > $1.baseline : $0.rect.minX < $1.rect.minX }
        var joined: [LayoutLine] = []
        for l in free {
            if var last = joined.last, abs(last.baseline - l.baseline) < max(1, l.size * 0.25), l.rect.minX > last.rect.maxX {
                if last.parts.isEmpty { last.parts = [last] }
                last.parts.append(l)
                last.tabStops.append(l.rect.minX)
                last.runs += [LayoutRun(text: "\t", font: l.runs[0].font, size: l.size, color: .black)] + l.runs
                last.rect = last.rect.union(l.rect)
                joined[joined.count - 1] = last
            } else {
                joined.append(l)
            }
        }
        free = joined
        var groups: [[LayoutLine]] = []
        func isListStart(_ text: String) -> Bool {
            guard let f = text.first else { return false }
            if "•●▪◦‣–—-*".contains(f) { return true }
            return text.range(of: #"^(\(?[0-9]{1,3}[.)]|\(?[a-zA-Z][.)]|[ivxIVX]{1,4}[.)])\s"#, options: .regularExpression) != nil
        }
        for l in free {
            if !isListStart(l.text), let gi = groups.indices.last(where: { idx in
                guard let last = groups[idx].last else { return false }
                let pitch = last.baseline - l.baseline
                let sameSize = abs(l.size - last.size) < max(l.size, last.size) * 0.18
                let spacing = pitch > l.size * 0.8 && pitch < l.size * 1.9
                let steady = groups[idx].count < 2 || abs(pitch - (groups[idx][groups[idx].count - 2].baseline - last.baseline)) < l.size * 0.35
                let overlap = min(l.rect.maxX, last.rect.maxX) - max(l.rect.minX, last.rect.minX) > 0
                let aligned = abs(l.rect.minX - groups[idx][min(1, groups[idx].count - 1)].rect.minX) < l.size * 3 || abs(l.rect.midX - last.rect.midX) < l.size
                return sameSize && spacing && steady && overlap && aligned
            }) {
                groups[gi].append(l)
            } else {
                groups.append([l])
            }
        }
        for g in groups {
            let rect = g.reduce(CGRect.null) { $0.union($1.rect) }
            let text = g.map(\.text).joined(separator: " ")
            let rtl = text.isRightToLeft
            var alignment: NSTextAlignment = rtl ? .right : .left
            if g.count > 1 {
                let lefts = g.map(\.rect.minX), rights = g.map(\.rect.maxX), mids = g.map(\.rect.midX)
                let leftAligned = lefts.allSatisfy { abs($0 - lefts[0]) < 2 }
                let rightAligned = rights.dropLast().allSatisfy { abs($0 - rights[0]) < 2.5 }
                if !leftAligned && mids.allSatisfy({ abs($0 - rect.midX) < 3 }) { alignment = .center }
                else if leftAligned && rightAligned && g.count > 2 { alignment = .justified }
                else if !leftAligned && rights.allSatisfy({ abs($0 - rights[0]) < 2 }) { alignment = .right }
            } else {
                // A short single line centred on the page is a title.
                let crop = page.bounds(for: .cropBox)
                if abs(rect.midX - crop.midX) < 6 && rect.minX - crop.minX > 90 { alignment = .center }
            }
            let pitch = g.count > 1 ? g[0].baseline - g[1].baseline : g[0].size * 1.2
            items.append(.paragraph(LayoutParagraph(rect: rect, lines: g, alignment: alignment, rightToLeft: rtl, pitch: pitch)))
        }

        // 4. Images (skipping full-page backgrounds behind real text, e.g. OCR'd scans).
        if includeImages {
            let crop = page.bounds(for: .cropBox)
            let hasText = !glyphs.isEmpty
            for obj in content.objects where obj.kind != .form && obj.bounds.width > 4 && obj.bounds.height > 4 {
                let r = obj.bounds.intersection(crop)
                guard !r.isNull else { continue }
                if hasText && r.width * r.height > crop.width * crop.height * 0.8 { continue }
                if let img = ImageExtractor.image(obj, content: content, page: page) { items.append(.image(img)) }
            }
        }

        // Reading order: top to bottom, then left to right among items on the same band.
        let layout = PageLayout(page: page, items: items)
        let ordered = items.sorted { a, b in
            let ra = layout.topLeft(a.rect), rb = layout.topLeft(b.rect)
            return abs(ra.minY - rb.minY) > 4 ? ra.minY < rb.minY : ra.minX < rb.minX
        }
        return PageLayout(page: page, items: ordered)
    }

    private static func table(_ rows: [[LayoutLine]]) -> LayoutTable {
        var starts: [CGFloat] = []
        for x in rows.flatMap({ $0.map(\.rect.minX) }).sorted() {
            if let last = starts.last, x - last < 10 { continue }
            starts.append(x)
        }
        let right = rows.flatMap { $0.map(\.rect.maxX) }.max() ?? 0
        var grid: [[LayoutLine?]] = []
        var rects: [CGRect] = []
        for r in rows {
            var cells = [LayoutLine?](repeating: nil, count: starts.count)
            for l in r {
                let c = starts.lastIndex { $0 <= l.rect.minX + 5 } ?? 0
                if var existing = cells[c] {
                    existing.runs += [LayoutRun(text: " ", font: existing.runs.last!.font, size: existing.size, color: .black)] + l.runs
                    existing.rect = existing.rect.union(l.rect)
                    cells[c] = existing
                } else { cells[c] = l }
            }
            grid.append(cells)
            rects.append(r.reduce(CGRect.null) { $0.union($1.rect) })
        }
        return LayoutTable(rect: rects.reduce(CGRect.null) { $0.union($1) }, columns: starts, right: right, rows: grid, rowRects: rects)
    }
}

extension ImageExtractor {
    /// The image's original JPEG, or a PNG rendered alone at its native resolution.
    static func image(_ obj: GraphicObject, content: PageContent, page: PDFPage) -> LayoutImage? {
        let info = content.imageInfo(for: obj)
        let pixel = CGSize(width: info?.width ?? 0, height: info?.height ?? 0)
        if let jpeg = info?.jpeg { return LayoutImage(rect: obj.bounds, data: jpeg, ext: "jpeg", pixelSize: pixel) }
        guard let data = content.isolatedPDF(for: obj), let solo = PDFDocument(data: data)?.page(at: 0) else { return nil }
        let crop = page.bounds(for: .cropBox)
        let native = pixel.width > 0 ? pixel.width / max(obj.bounds.width, 1) * 72 : 220
        let dpi = min(max(native, 96), 400)
        guard let full = PageRenderer.image(of: solo, dpi: dpi, annotations: false) else { return nil }
        let s = dpi / 72
        let r = obj.bounds.intersection(crop)
        let px = CGRect(x: (r.minX - crop.minX) * s, y: (crop.maxY - r.maxY) * s, width: r.width * s, height: r.height * s).integral
        guard let cut = full.cropping(to: px), let png = PageRenderer.encode(cut, type: .png) else { return nil }
        return LayoutImage(rect: r, data: png, ext: "png", pixelSize: CGSize(width: cut.width, height: cut.height))
    }
}
