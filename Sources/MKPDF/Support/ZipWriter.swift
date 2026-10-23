import Foundation
import Compression

/// Minimal ZIP writer for Office Open XML packages (.xlsx, .pptx). Entries are deflated.
struct ZipWriter {
    private var entries: [(name: String, data: Data, compressed: Data, crc: UInt32, method: UInt16)] = []

    mutating func add(_ name: String, _ data: Data) {
        let deflated = Self.deflate(data)
        let useDeflate = deflated.map { $0.count < data.count } ?? false
        entries.append((name, data, useDeflate ? deflated! : data, Self.crc32(data), useDeflate ? 8 : 0))
    }

    mutating func add(_ name: String, _ text: String) { add(name, Data(text.utf8)) }

    func data() -> Data {
        var out = Data()
        var central = Data()
        for e in entries {
            let offset = UInt32(out.count)
            let name = Data(e.name.utf8)
            var local = Data()
            local.append(le32(0x04034b50)); local.append(le16(20)); local.append(le16(0x0800)); local.append(le16(e.method))
            local.append(le16(0)); local.append(le16(0x21)) // time, date (1980-01-01)
            local.append(le32(e.crc)); local.append(le32(UInt32(e.compressed.count))); local.append(le32(UInt32(e.data.count)))
            local.append(le16(UInt16(name.count))); local.append(le16(0))
            out.append(local); out.append(name); out.append(e.compressed)

            central.append(le32(0x02014b50)); central.append(le16(20)); central.append(le16(20)); central.append(le16(0x0800))
            central.append(le16(e.method)); central.append(le16(0)); central.append(le16(0x21))
            central.append(le32(e.crc)); central.append(le32(UInt32(e.compressed.count))); central.append(le32(UInt32(e.data.count)))
            central.append(le16(UInt16(name.count))); central.append(le16(0)); central.append(le16(0))
            central.append(le16(0)); central.append(le16(0)); central.append(le32(0)); central.append(le32(offset))
            central.append(name)
        }
        let centralOffset = UInt32(out.count)
        out.append(central)
        out.append(le32(0x06054b50)); out.append(le16(0)); out.append(le16(0))
        out.append(le16(UInt16(entries.count))); out.append(le16(UInt16(entries.count)))
        out.append(le32(UInt32(central.count))); out.append(le32(centralOffset)); out.append(le16(0))
        return out
    }

    private func le16(_ v: UInt16) -> Data { Data([UInt8(v & 0xFF), UInt8(v >> 8)]) }
    private func le32(_ v: UInt32) -> Data { Data([UInt8(v & 0xFF), UInt8(v >> 8 & 0xFF), UInt8(v >> 16 & 0xFF), UInt8(v >> 24)]) }

    /// Raw DEFLATE (what ZIP method 8 expects).
    static func deflate(_ data: Data) -> Data? {
        guard !data.isEmpty else { return nil }
        let capacity = data.count + 1024
        var out = [UInt8](repeating: 0, count: capacity)
        let n = data.withUnsafeBytes { compression_encode_buffer(&out, capacity, $0.bindMemory(to: UInt8.self).baseAddress!, data.count, nil, COMPRESSION_ZLIB) }
        return n > 0 ? Data(out[0..<n]) : nil
    }

    private static let table: [UInt32] = (0..<256).map { i -> UInt32 in
        var c = UInt32(i)
        for _ in 0..<8 { c = c & 1 != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1 }
        return c
    }

    static func crc32(_ data: Data) -> UInt32 {
        var c: UInt32 = 0xFFFFFFFF
        for b in data { c = table[Int((c ^ UInt32(b)) & 0xFF)] ^ (c >> 8) }
        return c ^ 0xFFFFFFFF
    }
}

extension String {
    /// Escaped for XML text and attribute values.
    var xmlEscaped: String {
        var s = ""
        for ch in unicodeScalars {
            switch ch {
            case "&": s += "&amp;"
            case "<": s += "&lt;"
            case ">": s += "&gt;"
            case "\"": s += "&quot;"
            default:
                // XML 1.0 disallows most control characters.
                if ch.value < 0x20 && ch != "\t" && ch != "\n" && ch != "\r" { continue }
                s.unicodeScalars.append(ch)
            }
        }
        return s
    }
}
