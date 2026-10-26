import Foundation
import CoreGraphics
import CoreText

/// One glyph drawn by a text-showing operator.
public struct Glyph {
    /// Index of the string inside the operator's TJ array (0 for Tj, ' and ").
    public let element: Int
    public let bytes: Data
    /// Bounds in page space (default user space).
    public let rect: CGRect
    /// Horizontal displacement in text space, including character/word spacing and scaling.
    public let displacement: Double
    /// Baseline origin in page space.
    public let origin: CGPoint
    /// Effective font size on the page.
    public let size: Double
    /// True for normal left-to-right horizontal text (not rotated, skewed or mirrored).
    public let upright: Bool
    public let fontResource: String
    /// Fill colour the glyph was painted with, when it's a plain gray, RGB or CMYK colour.
    public let color: CGColor?
    /// Drawn with an invisible text render mode (typically an OCR text layer over a scan).
    public let invisible: Bool
}

public struct TextShow {
    public let opIndex: Int
    public let glyphs: [Glyph]
    public let fontSize: Double
    public let horizontalScale: Double
    public let fontResource: String
    public let baseFont: String
    public var bounds: CGRect { glyphs.reduce(CGRect.null) { $0.union($1.rect) } }
}

public struct GraphicObject {
    public enum Kind { case image, form, inlineImage }
    public let kind: Kind
    public let opIndex: Int
    public let name: String
    public let ctm: CGAffineTransform
    public let bounds: CGRect
}

/// Metrics for one font resource, enough to place every glyph.
final class FontMetrics {
    let bytesPerCode: Int
    let baseFont: String
    private var widths: [Int: Double] = [:]
    private let defaultWidth: Double
    private let scale: Double
    let ascent: Double
    let descent: Double
    private var fallback: CTFont?

    init(_ font: CGPDFDictionaryRef) {
        var name: UnsafePointer<CChar>?
        let subtype = CGPDFDictionaryGetName(font, "Subtype", &name) && name != nil ? String(cString: name!) : "Type1"
        var base = CGPDFDictionaryGetName(font, "BaseFont", &name) && name != nil ? String(cString: name!) : ""
        var descriptor: CGPDFDictionaryRef?
        var dw = 0.0
        var sc = 0.001

        if subtype == "Type0" {
            bytesPerCode = 2
            dw = 1000
            var descendants: CGPDFArrayRef?
            var cid: CGPDFDictionaryRef?
            if CGPDFDictionaryGetArray(font, "DescendantFonts", &descendants), let descendants,
               CGPDFArrayGetDictionary(descendants, 0, &cid), let cid {
                var n: CGPDFReal = 0
                if CGPDFDictionaryGetNumber(cid, "DW", &n) { dw = Double(n) }
                CGPDFDictionaryGetDictionary(cid, "FontDescriptor", &descriptor)
                var w: CGPDFArrayRef?
                if CGPDFDictionaryGetArray(cid, "W", &w), let w { widths = Self.cidWidths(w) }
            }
        } else {
            bytesPerCode = 1
            CGPDFDictionaryGetDictionary(font, "FontDescriptor", &descriptor)
            var first: CGPDFInteger = 0
            CGPDFDictionaryGetInteger(font, "FirstChar", &first)
            var w: CGPDFArrayRef?
            if CGPDFDictionaryGetArray(font, "Widths", &w), let w {
                for i in 0..<CGPDFArrayGetCount(w) {
                    var v: CGPDFReal = 0
                    if CGPDFArrayGetNumber(w, i, &v) { widths[Int(first) + i] = Double(v) }
                }
            }
            if let descriptor {
                var mw: CGPDFReal = 0
                if CGPDFDictionaryGetNumber(descriptor, "MissingWidth", &mw) { dw = Double(mw) }
                // Type 3 fonts (Chromium "Save as PDF") have no BaseFont; the descriptor still names the font and weight.
                var fontName: UnsafePointer<CChar>?
                if base.isEmpty, CGPDFDictionaryGetName(descriptor, "FontName", &fontName), let fontName {
                    base = String(cString: fontName)
                    var weight: CGPDFReal = 400
                    if CGPDFDictionaryGetNumber(descriptor, "FontWeight", &weight), weight >= 600, base.range(of: "bold|black|heavy|semibold|demi", options: [.regularExpression, .caseInsensitive]) == nil { base += "-Bold" }
                }
            }
            if subtype == "Type3" {
                var matrix: CGPDFArrayRef?
                var a: CGPDFReal = 0.001
                if CGPDFDictionaryGetArray(font, "FontMatrix", &matrix), let matrix, CGPDFArrayGetNumber(matrix, 0, &a) { sc = Double(a) }
            }
        }
        baseFont = base
        defaultWidth = dw
        scale = sc

        var asc: CGPDFReal = 0, desc: CGPDFReal = 0
        if let descriptor {
            CGPDFDictionaryGetNumber(descriptor, "Ascent", &asc)
            CGPDFDictionaryGetNumber(descriptor, "Descent", &desc)
        }
        ascent = asc > 0 ? min(1.2, max(0.5, Double(asc) / 1000)) : 0.8
        descent = desc < 0 ? max(-0.5, Double(desc) / 1000) : -0.2

        if widths.isEmpty && subtype != "Type0" {
            // Standard 14 fonts carry no widths; measure a matching system font.
            let family = Self.systemFamily(for: baseFont)
            fallback = CTFontCreateWithName(family as CFString, 1000, nil)
        }
    }

    /// Advance of a glyph code, in text space units per unit font size.
    func width(_ code: Int) -> Double {
        if let w = widths[code] { return w * scale }
        if let fallback {
            var ch = UniChar(code)
            var glyph: CGGlyph = 0
            if CTFontGetGlyphsForCharacters(fallback, &ch, &glyph, 1) {
                var adv = CGSize.zero
                CTFontGetAdvancesForGlyphs(fallback, .horizontal, &glyph, &adv, 1)
                widths[code] = Double(adv.width)
                return Double(adv.width) * 0.001
            }
            return 0.5
        }
        return defaultWidth * scale
    }

    static func systemFamily(for base: String) -> String {
        let b = base.lowercased()
        if b.contains("courier") { return "Courier" }
        if b.contains("times") { return "Times New Roman" }
        if b.contains("symbol") { return "Symbol" }
        return "Helvetica"
    }

    static func cidWidths(_ w: CGPDFArrayRef) -> [Int: Double] {
        var out: [Int: Double] = [:]
        var i = 0
        let n = CGPDFArrayGetCount(w)
        while i < n {
            var first: CGPDFInteger = 0
            guard CGPDFArrayGetInteger(w, i, &first) else { i += 1; continue }
            var list: CGPDFArrayRef?
            if i + 1 < n, CGPDFArrayGetArray(w, i + 1, &list), let list {
                for j in 0..<CGPDFArrayGetCount(list) {
                    var v: CGPDFReal = 0
                    if CGPDFArrayGetNumber(list, j, &v) { out[Int(first) + j] = Double(v) }
                }
                i += 2
            } else if i + 2 < n {
                var last: CGPDFInteger = 0
                var v: CGPDFReal = 0
                CGPDFArrayGetInteger(w, i + 1, &last)
                CGPDFArrayGetNumber(w, i + 2, &v)
                if last >= first, last - first < 70_000 { for c in Int(first)...Int(last) { out[c] = Double(v) } }
                i += 3
            } else {
                break
            }
        }
        return out
    }
}

/// A page's content stream, interpreted so text glyphs and placed objects have positions, and editable.
public final class PageContent {
    public let page: CGPDFPage
    public private(set) var operations: [ContentOperation]
    public private(set) var shows: [TextShow] = []
    public private(set) var objects: [GraphicObject] = []
    /// Thin painted lines and bars (table rules, underlines), page space.
    public private(set) var rules: [CGRect] = []
    /// Text drawn inside form XObjects can't be edited here; their bounds are listed so callers can tell.
    public var formBounds: [CGRect] { objects.filter { $0.kind == .form }.map(\.bounds) }

    private let resources: CGPDFDictionaryRef?
    /// Graphics-state nesting depth and transform in effect before each operation.
    private var depthAt: [Int] = []
    private var ctmAt: [CGAffineTransform] = []
    private var endCTM = CGAffineTransform.identity
    private var fonts: [String: FontMetrics] = [:]

    public init(page: CGPDFPage) {
        self.page = page
        operations = ContentStream.parse(PDFWriter.contentData(of: page))
        var res: CGPDFDictionaryRef?
        if let dict = page.dictionary { CGPDFDictionaryGetDictionary(dict, "Resources", &res) }
        resources = res
        analyze()
    }

    public var glyphs: [Glyph] { shows.flatMap(\.glyphs) }

    /// Writes the (edited) page as a standalone one-page PDF.
    public func pdfData() -> Data? {
        PDFWriter.page(from: page, content: ContentStream.serialize(operations))
    }

    /// The edited page with `overlay`'s drawing merged on top (see `PDFWriter.page(from:content:overlay:)`).
    public func pdfData(overlay: CGPDFPage) -> Data? {
        PDFWriter.page(from: page, content: ContentStream.serialize(operations), overlay: overlay)
    }

    // MARK: - Edits

    /// Removes every glyph for which `shouldRemove` returns true, keeping all other glyphs exactly in place.
    @discardableResult
    public func removeGlyphs(where shouldRemove: (Glyph) -> Bool) -> Int {
        var replacements: [Int: [ContentOperation]] = [:]
        var removedCount = 0
        for show in shows {
            let removed = show.glyphs.map(shouldRemove)
            let count = removed.filter { $0 }.count
            guard count > 0 else { continue }
            removedCount += count
            let original = operations[show.opIndex]
            let unit = show.fontSize * show.horizontalScale
            guard unit != 0 else { continue }

            // Rebuild the shown text as a TJ array, replacing removed glyphs with equal-width gaps.
            var elements: [PDFValue] = []
            func gap(_ displacement: Double) {
                let n = -displacement * 1000 / unit
                if case .number(let prev)? = elements.last { elements[elements.count - 1] = .number(prev + n) } else { elements.append(.number(n)) }
            }
            var chunk = Data()
            func flush() {
                if !chunk.isEmpty { elements.append(.string(chunk)); chunk = Data() }
            }
            let sourceElements: [PDFValue]
            if original.op == "TJ" { sourceElements = original.operands.first?.arrayValue ?? [] }
            else { sourceElements = [original.operands.last ?? .string(Data())] }

            var g = 0
            for (index, element) in sourceElements.enumerated() {
                switch element {
                case .string:
                    while g < show.glyphs.count, show.glyphs[g].element == index {
                        if removed[g] {
                            flush()
                            gap(show.glyphs[g].displacement)
                        } else {
                            chunk.append(show.glyphs[g].bytes)
                        }
                        g += 1
                    }
                    flush()
                case .number(let n):
                    flush()
                    if case .number(let prev)? = elements.last { elements[elements.count - 1] = .number(prev + n) } else { elements.append(.number(n)) }
                default:
                    break
                }
            }
            elements = elements.filter { if case .number(let n) = $0 { return abs(n) > 0.0001 } else { return true } }
            let tj = ContentOperation("TJ", [.array(elements)])
            switch original.op {
            case "'":
                replacements[show.opIndex] = [ContentOperation("T*"), tj]
            case "\"":
                let ops = original.operands
                replacements[show.opIndex] = [ContentOperation("Tw", [ops[0]]), ContentOperation("Tc", [ops[1]]), ContentOperation("T*"), tj]
            default:
                replacements[show.opIndex] = [tj]
            }
        }
        guard !replacements.isEmpty else { return 0 }
        var rebuilt: [ContentOperation] = []
        for (i, op) in operations.enumerated() {
            if let r = replacements[i] { rebuilt += r } else { rebuilt.append(op) }
        }
        operations = rebuilt
        analyze()
        return removedCount
    }

    /// Removes glyphs whose centre lies inside any of `rects` (page space).
    @discardableResult
    public func removeText(in rects: [CGRect]) -> Int {
        removeGlyphs { g in
            let c = CGPoint(x: g.rect.midX, y: g.rect.midY)
            return rects.contains { $0.contains(c) }
        }
    }

    public func removeObject(_ object: GraphicObject) {
        guard object.opIndex < operations.count else { return }
        operations.remove(at: object.opIndex)
        analyze()
    }

    /// Moves/scales a placed image or form so its bounds become `newBounds` (page space).
    /// The object is lifted out of any enclosing q…Q group (whose clip would hide it once moved)
    /// and redrawn right after that group, which keeps its place in the stacking order.
    public func transformObject(_ object: GraphicObject, to newBounds: CGRect) {
        let old = object.bounds
        let i = object.opIndex
        guard old.width > 0, old.height > 0, i < operations.count, i < depthAt.count else { return }
        let a = CGAffineTransform(translationX: -old.minX, y: -old.minY)
            .concatenating(CGAffineTransform(scaleX: newBounds.width / old.width, y: newBounds.height / old.height))
            .concatenating(CGAffineTransform(translationX: newBounds.minX, y: newBounds.minY))
        // First operation after the object at which we're back at the top level.
        var insertAt = i + 1
        while insertAt < operations.count, depthAt[insertAt] > 0 { insertAt += 1 }
        let baseCTM = insertAt < ctmAt.count ? ctmAt[insertAt] : endCTM
        let m = object.ctm.concatenating(a).concatenating(baseCTM.inverted())
        let cm = ContentOperation("cm", [m.a, m.b, m.c, m.d, m.tx, m.ty].map { .number(Double($0)) })
        let drawn = operations[i]
        operations.insert(contentsOf: [ContentOperation("q"), cm, drawn, ContentOperation("Q")], at: insertAt)
        operations.remove(at: i)
        analyze()
    }

    /// The original bytes of a placed image when they are a JPEG (saved as-is, no quality loss), plus its pixel size.
    public func imageInfo(for object: GraphicObject) -> (jpeg: Data?, width: Int, height: Int)? {
        guard object.kind == .image, let (stream, _) = xobject(object.name), let d = CGPDFStreamGetDictionary(stream) else { return nil }
        var w: CGPDFInteger = 0, h: CGPDFInteger = 0
        CGPDFDictionaryGetInteger(d, "Width", &w)
        CGPDFDictionaryGetInteger(d, "Height", &h)
        var format = CGPDFDataFormat.raw
        let data = CGPDFStreamCopyData(stream, &format) as Data?
        return (format == .jpegEncoded ? data : nil, Int(w), Int(h))
    }

    /// A one-page PDF that draws only `object`, for rendering it on its own.
    public func isolatedPDF(for object: GraphicObject) -> Data? {
        guard object.opIndex < operations.count else { return nil }
        let m = object.ctm
        let ops = [ContentOperation("q"), ContentOperation("cm", [m.a, m.b, m.c, m.d, m.tx, m.ty].map { .number(Double($0)) }),
                   operations[object.opIndex], ContentOperation("Q")]
        // Inline images carry their own placement relative to the CTM; forms and images are unit-square based.
        return PDFWriter.page(from: page, content: ContentStream.serialize(ops))
    }

    /// The embedded font program for a font resource, when Core Text can load it (TrueType or OpenType).
    public func fontProgram(for resource: String) -> Data? {
        guard let resources else { return nil }
        var fonts: CGPDFDictionaryRef?, font: CGPDFDictionaryRef?
        guard CGPDFDictionaryGetDictionary(resources, "Font", &fonts), let fonts,
              CGPDFDictionaryGetDictionary(fonts, resource, &font), var font else { return nil }
        var descendants: CGPDFArrayRef?, cid: CGPDFDictionaryRef?
        if CGPDFDictionaryGetArray(font, "DescendantFonts", &descendants), let descendants,
           CGPDFArrayGetDictionary(descendants, 0, &cid), let cid { font = cid }
        var descriptor: CGPDFDictionaryRef?
        guard CGPDFDictionaryGetDictionary(font, "FontDescriptor", &descriptor), let descriptor else { return nil }
        var stream: CGPDFStreamRef?
        if CGPDFDictionaryGetStream(descriptor, "FontFile2", &stream), let stream { return PDFWriter.decoded(stream) }
        if CGPDFDictionaryGetStream(descriptor, "FontFile3", &stream), let stream, let d = CGPDFStreamGetDictionary(stream) {
            var sub: UnsafePointer<CChar>?
            if CGPDFDictionaryGetName(d, "Subtype", &sub), let sub, String(cString: sub) == "OpenType" { return PDFWriter.decoded(stream) }
        }
        return nil
    }

    /// Appends operations drawn last, on top of everything (e.g. redaction boxes).
    public func append(_ ops: [ContentOperation]) {
        operations.append(ContentOperation("q"))
        operations += ops
        operations.append(ContentOperation("Q"))
        analyze()
    }

    // MARK: - Interpretation

    private struct GState {
        var ctm = CGAffineTransform.identity
        var charSpacing = 0.0
        var wordSpacing = 0.0
        var hScale = 1.0
        var leading = 0.0
        var fontName = ""
        var fontSize = 0.0
        var rise = 0.0
        var fill: CGColor? = CGColor(gray: 0, alpha: 1)
        var renderMode = 0
    }

    private func font(_ name: String) -> FontMetrics? {
        if let f = fonts[name] { return f }
        guard let resources else { return nil }
        var fontDict: CGPDFDictionaryRef?
        var f: CGPDFDictionaryRef?
        guard CGPDFDictionaryGetDictionary(resources, "Font", &fontDict), let fontDict,
              CGPDFDictionaryGetDictionary(fontDict, name, &f), let f else { return nil }
        let metrics = FontMetrics(f)
        fonts[name] = metrics
        return metrics
    }

    private func xobject(_ name: String) -> (CGPDFStreamRef, String)? {
        guard let resources else { return nil }
        var xo: CGPDFDictionaryRef?
        var s: CGPDFStreamRef?
        guard CGPDFDictionaryGetDictionary(resources, "XObject", &xo), let xo,
              CGPDFDictionaryGetStream(xo, name, &s), let s, let d = CGPDFStreamGetDictionary(s) else { return nil }
        var sub: UnsafePointer<CChar>?
        let subtype = CGPDFDictionaryGetName(d, "Subtype", &sub) && sub != nil ? String(cString: sub!) : ""
        return (s, subtype)
    }

    private func analyze() {
        shows = []
        objects = []
        rules = []
        var subpaths: [CGRect] = []
        var current = CGRect.null
        func addPoint(_ x: Double, _ y: Double, _ ctm: CGAffineTransform) {
            let p = CGPoint(x: x, y: y).applying(ctm)
            current = current.isNull ? CGRect(origin: p, size: .zero) : current.union(CGRect(origin: p, size: .zero))
        }
        func closeSubpath() {
            if !current.isNull { subpaths.append(current) }
            current = .null
        }
        var gs = GState()
        var stack: [GState] = []
        var tm = CGAffineTransform.identity
        var tlm = CGAffineTransform.identity

        func nums(_ op: ContentOperation) -> [Double] { op.operands.compactMap(\.number) }

        func show(_ elements: [PDFValue], opIndex: Int) {
            guard let metrics = font(gs.fontName) else {
                // Unknown font: still advance nothing but record nothing.
                return
            }
            var glyphs: [Glyph] = []
            let fs = gs.fontSize, th = gs.hScale
            for (index, element) in elements.enumerated() {
                switch element {
                case .string(let data):
                    let bytes = [UInt8](data)
                    var k = 0
                    while k < bytes.count {
                        let n = min(metrics.bytesPerCode, bytes.count - k)
                        var code = 0
                        for b in bytes[k..<(k + n)] { code = code << 8 | Int(b) }
                        let w0 = metrics.width(code)
                        var tx = w0 * fs + gs.charSpacing
                        if n == 1 && code == 32 { tx += gs.wordSpacing }
                        tx *= th
                        let toUser = tm.concatenating(gs.ctm)
                        let local = CGRect(x: 0, y: metrics.descent * fs + gs.rise, width: max(w0 * fs * th, 0.01), height: (metrics.ascent - metrics.descent) * fs)
                        let upright = abs(toUser.b) < 0.001 && abs(toUser.c) < 0.001 && toUser.a > 0 && toUser.d > 0
                        glyphs.append(Glyph(element: index, bytes: Data(bytes[k..<(k + n)]), rect: local.applying(toUser), displacement: tx,
                                            origin: CGPoint(x: 0, y: gs.rise).applying(toUser), size: fs * Double(hypot(toUser.c, toUser.d)),
                                            upright: upright, fontResource: gs.fontName, color: gs.fill,
                                            invisible: gs.renderMode == 3 || gs.renderMode == 7))
                        tm = CGAffineTransform(translationX: tx, y: 0).concatenating(tm)
                        k += n
                    }
                case .number(let adj):
                    tm = CGAffineTransform(translationX: -adj / 1000 * fs * th, y: 0).concatenating(tm)
                default:
                    break
                }
            }
            shows.append(TextShow(opIndex: opIndex, glyphs: glyphs, fontSize: fs, horizontalScale: th, fontResource: gs.fontName, baseFont: metrics.baseFont))
        }

        func nextLine() {
            tlm = CGAffineTransform(translationX: 0, y: -gs.leading).concatenating(tlm)
            tm = tlm
        }

        func color(_ n: [Double]) -> CGColor? {
            switch n.count {
            case 1: return CGColor(gray: n[0], alpha: 1)
            case 3: return CGColor(red: n[0], green: n[1], blue: n[2], alpha: 1)
            case 4: return CGColor(genericCMYKCyan: n[0], magenta: n[1], yellow: n[2], black: n[3], alpha: 1)
            default: return nil
            }
        }

        depthAt = []
        ctmAt = []
        for (index, op) in operations.enumerated() {
            depthAt.append(stack.count)
            ctmAt.append(gs.ctm)
            switch op.op {
            case "g", "rg", "k", "sc", "scn": gs.fill = color(nums(op))
            case "cs": gs.fill = op.operands.first?.nameValue == "DeviceRGB" ? CGColor(red: 0, green: 0, blue: 0, alpha: 1) : CGColor(gray: 0, alpha: 1)
            case "q": stack.append(gs)
            case "Q": if let s = stack.popLast() { gs = s }
            case "cm":
                let n = nums(op)
                if n.count == 6 { gs.ctm = CGAffineTransform(a: n[0], b: n[1], c: n[2], d: n[3], tx: n[4], ty: n[5]).concatenating(gs.ctm) }
            case "BT": tm = .identity; tlm = .identity
            case "Tc": gs.charSpacing = nums(op).first ?? 0
            case "Tw": gs.wordSpacing = nums(op).first ?? 0
            case "Tz": gs.hScale = (nums(op).first ?? 100) / 100
            case "TL": gs.leading = nums(op).first ?? 0
            case "Ts": gs.rise = nums(op).first ?? 0
            case "Tr": gs.renderMode = Int(nums(op).first ?? 0)
            case "Tf":
                if let name = op.operands.first?.nameValue { gs.fontName = name }
                gs.fontSize = nums(op).last ?? gs.fontSize
            case "Td", "TD":
                let n = nums(op)
                guard n.count == 2 else { break }
                if op.op == "TD" { gs.leading = -n[1] }
                tlm = CGAffineTransform(translationX: n[0], y: n[1]).concatenating(tlm)
                tm = tlm
            case "Tm":
                let n = nums(op)
                if n.count == 6 { tm = CGAffineTransform(a: n[0], b: n[1], c: n[2], d: n[3], tx: n[4], ty: n[5]); tlm = tm }
            case "T*": nextLine()
            case "Tj": if let s = op.operands.last { show([s], opIndex: index) }
            case "TJ": if let a = op.operands.first?.arrayValue { show(a, opIndex: index) }
            case "'":
                nextLine()
                if let s = op.operands.last { show([s], opIndex: index) }
            case "\"":
                let n = nums(op)
                if n.count >= 2 { gs.wordSpacing = n[0]; gs.charSpacing = n[1] }
                nextLine()
                if let s = op.operands.last { show([s], opIndex: index) }
            case "Do":
                guard let name = op.operands.first?.nameValue, let (stream, subtype) = xobject(name) else { break }
                if subtype == "Image" {
                    let rect = CGRect(x: 0, y: 0, width: 1, height: 1).applying(gs.ctm)
                    objects.append(GraphicObject(kind: .image, opIndex: index, name: name, ctm: gs.ctm, bounds: rect))
                } else if subtype == "Form", let d = CGPDFStreamGetDictionary(stream) {
                    var bbox = CGRect(x: 0, y: 0, width: 1, height: 1)
                    var arr: CGPDFArrayRef?
                    if CGPDFDictionaryGetArray(d, "BBox", &arr), let arr {
                        var v = [CGPDFReal](repeating: 0, count: 4)
                        for i in 0..<4 { CGPDFArrayGetNumber(arr, i, &v[i]) }
                        bbox = CGRect(x: min(v[0], v[2]), y: min(v[1], v[3]), width: abs(v[2] - v[0]), height: abs(v[3] - v[1]))
                    }
                    var matrix = CGAffineTransform.identity
                    if CGPDFDictionaryGetArray(d, "Matrix", &arr), let arr, CGPDFArrayGetCount(arr) == 6 {
                        var v = [CGPDFReal](repeating: 0, count: 6)
                        for i in 0..<6 { CGPDFArrayGetNumber(arr, i, &v[i]) }
                        matrix = CGAffineTransform(a: v[0], b: v[1], c: v[2], d: v[3], tx: v[4], ty: v[5])
                    }
                    objects.append(GraphicObject(kind: .form, opIndex: index, name: name, ctm: gs.ctm,
                                                 bounds: bbox.applying(matrix.concatenating(gs.ctm))))
                }
            case "m":
                closeSubpath()
                let n = nums(op)
                if n.count >= 2 { addPoint(n[0], n[1], gs.ctm) }
            case "l":
                let n = nums(op)
                if n.count >= 2 { addPoint(n[0], n[1], gs.ctm) }
            case "re":
                closeSubpath()
                let n = nums(op)
                if n.count == 4 { addPoint(n[0], n[1], gs.ctm); addPoint(n[0] + n[2], n[1] + n[3], gs.ctm); closeSubpath() }
            case "S", "s", "f", "F", "f*", "B", "B*", "b", "b*":
                closeSubpath()
                for r in subpaths where (r.width < 2.5 && r.height > 4) || (r.height < 2.5 && r.width > 4) { rules.append(r) }
                subpaths = []
            case "n":
                current = .null
                subpaths = []
            case "BI":
                objects.append(GraphicObject(kind: .inlineImage, opIndex: index, name: "inline", ctm: gs.ctm,
                                             bounds: CGRect(x: 0, y: 0, width: 1, height: 1).applying(gs.ctm)))
            default:
                break
            }
        }
        endCTM = gs.ctm
    }
}
