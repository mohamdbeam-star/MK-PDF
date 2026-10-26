import Foundation
import CoreGraphics
import Compression

/// Writes a standalone one-page PDF that reuses an existing page's resources (fonts, images, forms)
/// with a new content stream. This is what lets MK PDF change the actual page content.
public final class PDFWriter {
    private var bodies: [Data?] = []
    private var ids: [UnsafeRawPointer: Int] = [:]
    /// Whole-document mode: pages are written explicitly, so other objects keep their /Parent and /P links
    /// (form field trees, outline items, popups); in single-page mode those would drag the document along.
    private var keepLinks = false

    public init() {}

    /// Builds a PDF whose single page has `content` drawn with `source`'s resources.
    public static func page(from source: CGPDFPage, content: Data, extraResources: [String: [(String, String)]] = [:]) -> Data? {
        build(from: source, content: content) { _ in extraResources }
    }

    /// Like `page(from:content:)`, with `overlay`'s drawing (new text or marks drawn by Core Graphics on a page of
    /// the same size) added on top. The overlay's operations are merged into the page's own content with their
    /// resources renamed, so the original content is kept exactly as it was, never re-drawn through Quartz (which
    /// turns Type 3 fonts, as written by Chromium-based browsers, into outlines that can no longer be edited),
    /// and the new text stays ordinary page text that can be edited again.
    public static func page(from source: CGPDFPage, content: Data, overlay: CGPDFPage) -> Data? {
        let existing = resourceNames(of: source)
        var n = 1
        while existing.contains(where: { $0.hasPrefix("MKo\(n)_") }) { n += 1 }
        let prefix = "MKo\(n)_"
        let ops = ContentStream.parse(contentData(of: overlay)).map { renamingResources($0, prefix: prefix) }
        var merged = Data("q\n".utf8)
        merged.append(content)
        merged.append(Data("\nQ\nq\n".utf8))
        merged.append(ContentStream.serialize(ops))
        merged.append(Data("Q\n".utf8))
        return build(from: source, content: merged) { w in
            var extra: [String: [(String, String)]] = [:]
            var res: CGPDFDictionaryRef?
            guard let dict = overlay.dictionary, CGPDFDictionaryGetDictionary(dict, "Resources", &res), let res else { return extra }
            for category in ["Font", "XObject", "ExtGState", "ColorSpace", "Pattern", "Shading", "Properties"] {
                var sub: CGPDFDictionaryRef?
                guard CGPDFDictionaryGetDictionary(res, category, &sub), let sub else { continue }
                var items: [(String, String)] = []
                CGPDFDictionaryApplyBlock(sub, { key, object, _ in
                    if let v = w.serialize(object) { items.append((prefix + String(cString: key), v)) }
                    return true
                }, nil)
                if !items.isEmpty { extra[category] = items }
            }
            return extra
        }
    }

    /// One page of a whole-document write: its content and resources come from `source` untouched; its
    /// annotations from `annotations` (another rendition of the same page); `aliases` are other dictionaries
    /// that stand for this page (so links and outline entries pointing at them land on it).
    public struct DocumentPage {
        public var source: CGPDFPage
        public var annotations: CGPDFArrayRef?
        public var rotation: Int
        public var cropBox: CGRect?
        public var aliases: [CGPDFDictionaryRef]
        public init(source: CGPDFPage, annotations: CGPDFArrayRef?, rotation: Int, cropBox: CGRect?, aliases: [CGPDFDictionaryRef]) {
            self.source = source; self.annotations = annotations; self.rotation = rotation; self.cropBox = cropBox; self.aliases = aliases
        }
    }

    /// Writes a document from pages that may come from different PDFs, copying each page's own content and
    /// resources as they are. Catalog entries (outlines, form fields, names, page labels…) and the document
    /// information come from `catalog` and `info`.
    public static func document(pages: [DocumentPage], catalog: CGPDFDictionaryRef?, info: CGPDFDictionaryRef?) -> Data? {
        let w = PDFWriter()
        w.keepLinks = true
        let root = w.reserve(), tree = w.reserve()
        let numbers = pages.map { _ in w.reserve() }
        for (p, n) in zip(pages, numbers) {
            if let d = p.source.dictionary { w.ids[unsafeBitCast(d, to: UnsafeRawPointer.self)] = n }
            for a in p.aliases { w.ids[unsafeBitCast(a, to: UnsafeRawPointer.self)] = n }
        }
        for (p, n) in zip(pages, numbers) {
            guard let dict = p.source.dictionary else { return nil }
            var body = w.entries(dict, skipping: ["Parent", "Type", "Annots", "Rotate", "CropBox", "B", "StructParents", "Tabs"])
            body += " /Type /Page /Parent \(tree) 0 R"
            if let r = p.cropBox { body += " /CropBox [\(fmt(r.minX)) \(fmt(r.minY)) \(fmt(r.maxX)) \(fmt(r.maxY))]" }
            if p.rotation % 360 != 0 { body += " /Rotate \(((p.rotation % 360) + 360) % 360)" }
            if let a = p.annotations {
                var items: [String] = []
                for i in 0..<CGPDFArrayGetCount(a) {
                    var o: CGPDFObjectRef?
                    if CGPDFArrayGetObject(a, i, &o), let o, let v = w.serialize(o) { items.append(v) }
                }
                if !items.isEmpty { body += " /Annots [" + items.joined(separator: " ") + "]" }
            }
            w.set(n, "<<\(body)>>")
        }
        w.set(tree, "<< /Type /Pages /Kids [\(numbers.map { "\($0) 0 R" }.joined(separator: " "))] /Count \(pages.count) >>")
        let extra = catalog.map { w.entries($0, skipping: ["Pages", "Type", "StructTreeRoot", "MarkInfo", "Perms", "Version"]) } ?? ""
        w.set(root, "<< /Type /Catalog /Pages \(tree) 0 R\(extra) >>")
        let infoRef = info.map { w.reference($0) }
        return w.finish(root: root, info: infoRef)
    }

    /// Every resource name a page uses (fonts, images, graphics states…), across categories.
    static func resourceNames(of page: CGPDFPage) -> Set<String> {
        var names = Set<String>()
        var res: CGPDFDictionaryRef?
        guard let dict = page.dictionary, CGPDFDictionaryGetDictionary(dict, "Resources", &res), let res else { return names }
        CGPDFDictionaryApplyBlock(res, { _, object, _ in
            var sub: CGPDFDictionaryRef?
            if CGPDFObjectGetValue(object, .dictionary, &sub), let sub {
                CGPDFDictionaryApplyBlock(sub, { key, _, _ in names.insert(String(cString: key)); return true }, nil)
            }
            return true
        }, nil)
        return names
    }

    /// The operation with every resource name it refers to prefixed (fonts, XObjects, graphics states, colour
    /// spaces, patterns, shadings and marked-content properties).
    static func renamingResources(_ op: ContentOperation, prefix: String) -> ContentOperation {
        var o = op
        func rename(_ i: Int) {
            guard o.operands.indices.contains(i), case .name(let n) = o.operands[i] else { return }
            o.operands[i] = .name(prefix + n)
            o.source = nil
        }
        switch op.op {
        case "Tf", "Do", "gs", "sh": rename(0)
        case "cs", "CS":
            if let n = op.operands.first?.nameValue, !["DeviceGray", "DeviceRGB", "DeviceCMYK", "Pattern"].contains(n) { rename(0) }
        case "scn", "SCN": rename(op.operands.count - 1)
        case "BDC", "DP": rename(1)
        default: break
        }
        return o
    }

    private static func build(from source: CGPDFPage, content: Data, extra: (PDFWriter) -> [String: [(String, String)]]) -> Data? {
        guard let pageDict = source.dictionary else { return nil }
        let w = PDFWriter()
        let catalog = w.reserve(), pages = w.reserve(), page = w.reserve()
        let extraResources = extra(w)
        var resources = "<<>>"
        var dict: CGPDFDictionaryRef?
        if CGPDFDictionaryGetDictionary(pageDict, "Resources", &dict), let dict {
            resources = w.dictionaryBody(dict, extra: extraResources)
        } else if !extraResources.isEmpty {
            resources = "<<" + extraResources.map { cat, items in "/\(cat) <<" + items.map { "/\($0.0) \($0.1)" }.joined(separator: " ") + ">>" }.joined(separator: " ") + ">>"
        }
        var group = ""
        if CGPDFDictionaryGetDictionary(pageDict, "Group", &dict), let dict { group = " /Group \(w.reference(dict))" }
        let media = source.getBoxRect(.mediaBox)
        let contents = w.add(stream: content, dict: "")
        w.set(catalog, "<< /Type /Catalog /Pages \(pages) 0 R >>")
        w.set(pages, "<< /Type /Pages /Kids [\(page) 0 R] /Count 1 >>")
        w.set(page, "<< /Type /Page /Parent \(pages) 0 R /MediaBox [\(fmt(media.minX)) \(fmt(media.minY)) \(fmt(media.maxX)) \(fmt(media.maxY))] /Resources \(resources) /Contents \(contents) 0 R\(group) >>")
        return w.finish(root: catalog)
    }

    /// The decoded content of a page (multiple content streams are joined).
    public static func contentData(of page: CGPDFPage) -> Data {
        guard let dict = page.dictionary else { return Data() }
        var out = Data()
        var stream: CGPDFStreamRef?
        var array: CGPDFArrayRef?
        if CGPDFDictionaryGetStream(dict, "Contents", &stream), let stream {
            out.append(decoded(stream))
        } else if CGPDFDictionaryGetArray(dict, "Contents", &array), let array {
            for i in 0..<CGPDFArrayGetCount(array) {
                var s: CGPDFStreamRef?
                if CGPDFArrayGetStream(array, i, &s), let s {
                    out.append(decoded(s))
                    out.append(0x0A)
                }
            }
        }
        return out
    }

    static func decoded(_ stream: CGPDFStreamRef) -> Data {
        var format = CGPDFDataFormat.raw
        return (CGPDFStreamCopyData(stream, &format) as Data?) ?? Data()
    }

    static func fmt(_ v: CGFloat) -> String { PDFValue.format(Double(v)) }

    // MARK: - Object table

    private func reserve() -> Int {
        bodies.append(nil)
        return bodies.count
    }

    private func set(_ num: Int, _ body: String) { bodies[num - 1] = Data(body.utf8) }

    private func add(stream data: Data, dict: String, compress: Bool = true) -> Int {
        let num = reserve()
        bodies[num - 1] = streamBody(data, dict: dict, compress: compress)
        return num
    }

    private func streamBody(_ data: Data, dict: String, compress: Bool, filter: String? = nil) -> Data {
        var payload = data
        var filterEntry = filter.map { " /Filter /\($0)" } ?? ""
        if filter == nil, compress, data.count > 64, let z = Self.zlib(data) {
            payload = z
            filterEntry = " /Filter /FlateDecode"
        }
        var out = Data("<<\(dict) /Length \(payload.count)\(filterEntry)>>\nstream\n".utf8)
        out.append(payload)
        out.append(Data("\nendstream".utf8))
        return out
    }

    private func finish(root: Int, info: String? = nil) -> Data {
        var out = Data("%PDF-1.7\n%\u{E2}\u{E3}\u{CF}\u{D3}\n".utf8)
        var offsets: [Int] = []
        for (i, body) in bodies.enumerated() {
            offsets.append(out.count)
            out.append(Data("\(i + 1) 0 obj\n".utf8))
            out.append(body ?? Data("null".utf8))
            out.append(Data("\nendobj\n".utf8))
        }
        let xref = out.count
        var table = "xref\n0 \(bodies.count + 1)\n0000000000 65535 f \n"
        for o in offsets { table += String(format: "%010d 00000 n \n", o) }
        table += "trailer\n<< /Size \(bodies.count + 1) /Root \(root) 0 R\(info.map { " /Info \($0)" } ?? "") >>\nstartxref\n\(xref)\n%%EOF\n"
        out.append(Data(table.utf8))
        return out
    }

    // MARK: - Copying objects

    /// An indirect reference to a copy of `dict`, written once even if shared.
    private func reference(_ dict: CGPDFDictionaryRef) -> String {
        if let id = ids[unsafeBitCast(dict, to: UnsafeRawPointer.self)] { return "\(id) 0 R" }
        let num = reserve()
        ids[unsafeBitCast(dict, to: UnsafeRawPointer.self)] = num
        bodies[num - 1] = Data(dictionaryBody(dict).utf8)
        return "\(num) 0 R"
    }

    private func reference(_ stream: CGPDFStreamRef) -> String {
        if let id = ids[unsafeBitCast(stream, to: UnsafeRawPointer.self)] { return "\(id) 0 R" }
        let num = reserve()
        ids[unsafeBitCast(stream, to: UnsafeRawPointer.self)] = num
        var format = CGPDFDataFormat.raw
        let data = (CGPDFStreamCopyData(stream, &format) as Data?) ?? Data()
        let filter: String? = format == .jpegEncoded ? "DCTDecode" : format == .JPEG2000 ? "JPXDecode" : nil
        var dict = ""
        if let sd = CGPDFStreamGetDictionary(stream) {
            dict = entries(sd, skipping: ["Length", "Filter", "DecodeParms", "DL", "F", "FFilter", "FDecodeParms"])
        }
        bodies[num - 1] = streamBody(data, dict: dict, compress: true, filter: filter)
        return "\(num) 0 R"
    }

    private func dictionaryBody(_ dict: CGPDFDictionaryRef, extra: [String: [(String, String)]] = [:]) -> String {
        var body = entries(dict, skipping: Set(extra.keys))
        for (category, items) in extra {
            var merged = ""
            var sub: CGPDFDictionaryRef?
            if CGPDFDictionaryGetDictionary(dict, category, &sub), let sub { merged = entries(sub) }
            merged += items.map { " /\(PDFValue.escapeName($0.0)) \($0.1)" }.joined()
            body += " /\(category) <<\(merged)>>"
        }
        return "<<\(body)>>"
    }

    private func entries(_ dict: CGPDFDictionaryRef, skipping: Set<String> = []) -> String {
        var parts: [String] = []
        CGPDFDictionaryApplyBlock(dict, { key, object, _ in
            let k = String(cString: key)
            // Back-links to the page tree would drag the whole document along.
            if !skipping.contains(k), self.keepLinks || (k != "Parent" && k != "P"), let v = self.serialize(object) { parts.append(" /\(PDFValue.escapeName(k)) \(v)") }
            return true
        }, nil)
        return parts.joined()
    }

    fileprivate func serialize(_ object: CGPDFObjectRef) -> String? {
        switch CGPDFObjectGetType(object) {
        case .null: return "null"
        case .boolean:
            var b: CGPDFBoolean = 0
            CGPDFObjectGetValue(object, .boolean, &b)
            return b != 0 ? "true" : "false"
        case .integer:
            var n: CGPDFInteger = 0
            CGPDFObjectGetValue(object, .integer, &n)
            return "\(n)"
        case .real:
            var r: CGPDFReal = 0
            CGPDFObjectGetValue(object, .real, &r)
            return PDFValue.format(Double(r))
        case .name:
            var p: UnsafePointer<CChar>?
            guard CGPDFObjectGetValue(object, .name, &p), let p else { return nil }
            return "/" + PDFValue.escapeName(String(cString: p))
        case .string:
            var s: CGPDFStringRef?
            guard CGPDFObjectGetValue(object, .string, &s), let s, let ptr = CGPDFStringGetBytePtr(s) else { return "<>" }
            let data = Data(bytes: ptr, count: CGPDFStringGetLength(s))
            return PDFValue.string(data).serialized()
        case .array:
            var a: CGPDFArrayRef?
            guard CGPDFObjectGetValue(object, .array, &a), let a else { return nil }
            var items: [String] = []
            for i in 0..<CGPDFArrayGetCount(a) {
                var o: CGPDFObjectRef?
                if CGPDFArrayGetObject(a, i, &o), let o, let v = serialize(o) { items.append(v) } else { items.append("null") }
            }
            return "[" + items.joined(separator: " ") + "]"
        case .dictionary:
            var d: CGPDFDictionaryRef?
            guard CGPDFObjectGetValue(object, .dictionary, &d), let d else { return nil }
            return reference(d)
        case .stream:
            var s: CGPDFStreamRef?
            guard CGPDFObjectGetValue(object, .stream, &s), let s else { return nil }
            return reference(s)
        @unknown default:
            return nil
        }
    }

    // MARK: - Flate

    static func zlib(_ data: Data) -> Data? {
        let capacity = data.count + data.count / 10 + 64
        var out = [UInt8](repeating: 0, count: capacity)
        let written = data.withUnsafeBytes { src -> Int in
            compression_encode_buffer(&out, capacity, src.bindMemory(to: UInt8.self).baseAddress!, data.count, nil, COMPRESSION_ZLIB)
        }
        guard written > 0 else { return nil }
        var result = Data([0x78, 0x9C])
        result.append(contentsOf: out[0..<written])
        var a: UInt32 = 1, b: UInt32 = 0
        for byte in data {
            a = (a + UInt32(byte)) % 65521
            b = (b + a) % 65521
        }
        let adler = (b << 16) | a
        result.append(contentsOf: [UInt8(adler >> 24), UInt8(adler >> 16 & 0xFF), UInt8(adler >> 8 & 0xFF), UInt8(adler & 0xFF)])
        return result
    }
}
