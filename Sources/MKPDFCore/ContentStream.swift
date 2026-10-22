import Foundation

/// A value in a PDF content stream.
public indirect enum PDFValue: Equatable {
    case number(Double)
    case string(Data)
    case name(String)
    case bool(Bool)
    case null
    case array([PDFValue])
    case dict([(String, PDFValue)])

    public static func == (a: PDFValue, b: PDFValue) -> Bool {
        switch (a, b) {
        case let (.number(x), .number(y)): return x == y
        case let (.string(x), .string(y)): return x == y
        case let (.name(x), .name(y)): return x == y
        case let (.bool(x), .bool(y)): return x == y
        case (.null, .null): return true
        case let (.array(x), .array(y)): return x == y
        case let (.dict(x), .dict(y)): return x.map(\.0) == y.map(\.0) && x.map(\.1) == y.map(\.1)
        default: return false
        }
    }

    public var number: Double? { if case .number(let n) = self { return n } else { return nil } }
    public var stringData: Data? { if case .string(let s) = self { return s } else { return nil } }
    public var nameValue: String? { if case .name(let n) = self { return n } else { return nil } }
    public var arrayValue: [PDFValue]? { if case .array(let a) = self { return a } else { return nil } }

    /// PDF syntax for the value.
    public func serialized() -> String {
        switch self {
        case .number(let n): return PDFValue.format(n)
        case .string(let d): return "<" + d.map { String(format: "%02X", $0) }.joined() + ">"
        case .name(let n): return "/" + PDFValue.escapeName(n)
        case .bool(let b): return b ? "true" : "false"
        case .null: return "null"
        case .array(let a): return "[" + a.map { $0.serialized() }.joined(separator: " ") + "]"
        case .dict(let d): return "<<" + d.map { "/\(PDFValue.escapeName($0.0)) \($0.1.serialized())" }.joined(separator: " ") + ">>"
        }
    }

    public static func format(_ n: Double) -> String {
        if n == n.rounded(), abs(n) < 1e15 { return String(Int64(n)) }
        var s = String(format: "%.5f", n)
        while s.hasSuffix("0") { s.removeLast() }
        if s.hasSuffix(".") { s.removeLast() }
        return s == "-0" ? "0" : s
    }

    static func escapeName(_ n: String) -> String {
        var out = ""
        for b in n.utf8 {
            if b < 33 || b > 126 || "()<>[]{}/%#".utf8.contains(b) { out += String(format: "#%02X", b) } else { out.append(Character(UnicodeScalar(b))) }
        }
        return out
    }
}

/// One operator with its operands, plus the bytes it came from so unchanged operations are copied verbatim.
public struct ContentOperation {
    public var op: String
    public var operands: [PDFValue]
    /// Original bytes (operands + operator), or nil when the operation was created or changed.
    public var source: Data?

    public init(_ op: String, _ operands: [PDFValue] = [], source: Data? = nil) {
        self.op = op
        self.operands = operands
        self.source = source
    }

    public func serialized() -> Data {
        if let source { return source }
        let text = (operands.map { $0.serialized() } + [op]).joined(separator: " ")
        return Data(text.utf8)
    }
}

public enum ContentStream {
    public static func serialize(_ ops: [ContentOperation]) -> Data {
        var out = Data()
        for op in ops {
            out.append(op.serialized())
            out.append(0x0A)
        }
        return out
    }

    public static func parse(_ data: Data) -> [ContentOperation] {
        var parser = Parser(bytes: [UInt8](data))
        return parser.operations()
    }

    struct Parser {
        let bytes: [UInt8]
        var i = 0

        init(bytes: [UInt8]) { self.bytes = bytes }

        static func isWhite(_ b: UInt8) -> Bool { b == 0 || b == 9 || b == 10 || b == 12 || b == 13 || b == 32 }
        static func isDelimiter(_ b: UInt8) -> Bool { "()<>[]{}/%".utf8.contains(b) }

        mutating func skipWhite() {
            while i < bytes.count {
                if Self.isWhite(bytes[i]) { i += 1 }
                else if bytes[i] == UInt8(ascii: "%") { while i < bytes.count, bytes[i] != 10, bytes[i] != 13 { i += 1 } }
                else { break }
            }
        }

        enum Token {
            case value(PDFValue)
            case arrayStart, arrayEnd, dictStart, dictEnd
            case keyword(String)
        }

        mutating func token() -> Token? {
            skipWhite()
            guard i < bytes.count else { return nil }
            let b = bytes[i]
            switch b {
            case UInt8(ascii: "["): i += 1; return .arrayStart
            case UInt8(ascii: "]"): i += 1; return .arrayEnd
            case UInt8(ascii: "{"), UInt8(ascii: "}"): i += 1; return .keyword(String(UnicodeScalar(b)))
            case UInt8(ascii: "<"):
                if i + 1 < bytes.count, bytes[i + 1] == UInt8(ascii: "<") { i += 2; return .dictStart }
                return .value(.string(hexString()))
            case UInt8(ascii: ">"):
                if i + 1 < bytes.count, bytes[i + 1] == UInt8(ascii: ">") { i += 2; return .dictEnd }
                i += 1
                return token()
            case UInt8(ascii: "("): return .value(.string(literalString()))
            case UInt8(ascii: "/"): return .value(.name(name()))
            case UInt8(ascii: ")"): i += 1; return token()
            default:
                let start = i
                while i < bytes.count, !Self.isWhite(bytes[i]), !Self.isDelimiter(bytes[i]) { i += 1 }
                if i == start { i += 1; return token() }
                let word = String(decoding: bytes[start..<i], as: UTF8.self)
                if let first = word.first, first == "+" || first == "-" || first == "." || first.isNumber {
                    if let n = Double(word) { return .value(.number(n)) }
                    // Malformed numbers like "--5" or "1.2.3": take what parses.
                    let cleaned = word.drop { $0 == "-" || $0 == "+" }
                    if let n = Double(cleaned) { return .value(.number(word.hasPrefix("-") ? -n : n)) }
                    return .value(.number(0))
                }
                switch word {
                case "true": return .value(.bool(true))
                case "false": return .value(.bool(false))
                case "null": return .value(.null)
                default: return .keyword(word)
                }
            }
        }

        mutating func hexString() -> Data {
            i += 1
            var out = Data()
            var high: UInt8?
            while i < bytes.count, bytes[i] != UInt8(ascii: ">") {
                if let v = Self.hexValue(bytes[i]) {
                    if let h = high { out.append(h << 4 | v); high = nil } else { high = v }
                }
                i += 1
            }
            if let h = high { out.append(h << 4) }
            i += 1
            return out
        }

        static func hexValue(_ b: UInt8) -> UInt8? {
            switch b {
            case 48...57: return b - 48
            case 65...70: return b - 55
            case 97...102: return b - 87
            default: return nil
            }
        }

        mutating func literalString() -> Data {
            i += 1
            var out = Data()
            var depth = 1
            while i < bytes.count {
                let b = bytes[i]
                if b == UInt8(ascii: "\\") {
                    i += 1
                    guard i < bytes.count else { break }
                    let e = bytes[i]
                    switch e {
                    case UInt8(ascii: "n"): out.append(10)
                    case UInt8(ascii: "r"): out.append(13)
                    case UInt8(ascii: "t"): out.append(9)
                    case UInt8(ascii: "b"): out.append(8)
                    case UInt8(ascii: "f"): out.append(12)
                    case 13: if i + 1 < bytes.count, bytes[i + 1] == 10 { i += 1 }
                    case 10: break
                    case 48...55:
                        var v = Int(e - 48)
                        var n = 1
                        while n < 3, i + 1 < bytes.count, (48...55).contains(bytes[i + 1]) {
                            i += 1
                            v = v * 8 + Int(bytes[i] - 48)
                            n += 1
                        }
                        out.append(UInt8(v & 0xFF))
                    default: out.append(e)
                    }
                    i += 1
                    continue
                }
                if b == UInt8(ascii: "(") { depth += 1 }
                if b == UInt8(ascii: ")") {
                    depth -= 1
                    if depth == 0 { i += 1; break }
                }
                out.append(b)
                i += 1
            }
            return out
        }

        mutating func name() -> String {
            i += 1
            var out = [UInt8]()
            while i < bytes.count, !Self.isWhite(bytes[i]), !Self.isDelimiter(bytes[i]) {
                if bytes[i] == UInt8(ascii: "#"), i + 2 < bytes.count, let h = Self.hexValue(bytes[i + 1]), let l = Self.hexValue(bytes[i + 2]) {
                    out.append(h << 4 | l)
                    i += 3
                } else {
                    out.append(bytes[i])
                    i += 1
                }
            }
            return String(decoding: out, as: UTF8.self)
        }

        /// Reads a complete value starting with `first` (arrays and dictionaries nest).
        mutating func value(after first: Token) -> PDFValue? {
            switch first {
            case .value(let v): return v
            case .arrayStart:
                var items: [PDFValue] = []
                while let t = token() {
                    if case .arrayEnd = t { break }
                    if let v = value(after: t) { items.append(v) }
                }
                return .array(items)
            case .dictStart:
                var items: [(String, PDFValue)] = []
                var key: String?
                while let t = token() {
                    if case .dictEnd = t { break }
                    guard let v = value(after: t) else { continue }
                    if let k = key { items.append((k, v)); key = nil } else if case .name(let n) = v { key = n }
                }
                return .dict(items)
            default:
                return nil
            }
        }

        mutating func operations() -> [ContentOperation] {
            var ops: [ContentOperation] = []
            var operands: [PDFValue] = []
            var opStart = i
            skipWhite()
            opStart = i
            while let t = token() {
                switch t {
                case .keyword(let word):
                    if word == "BI" {
                        let data = inlineImage(from: opStart)
                        ops.append(ContentOperation("BI", [], source: data))
                    } else {
                        ops.append(ContentOperation(word, operands, source: Data(bytes[opStart..<i])))
                    }
                    operands = []
                    skipWhite()
                    opStart = i
                case .arrayEnd, .dictEnd:
                    break
                default:
                    if let v = value(after: t) { operands.append(v) }
                }
            }
            return ops
        }

        /// Consumes an inline image (BI … ID data EI) and returns its bytes.
        mutating func inlineImage(from start: Int) -> Data {
            // Skip the dictionary up to ID.
            while let t = token() {
                if case .keyword("ID") = t { break }
            }
            i += 1 // single whitespace after ID
            while i + 1 < bytes.count {
                if bytes[i] == UInt8(ascii: "E"), bytes[i + 1] == UInt8(ascii: "I"),
                   i > 0, Self.isWhite(bytes[i - 1]), i + 2 >= bytes.count || Self.isWhite(bytes[i + 2]) || Self.isDelimiter(bytes[i + 2]) {
                    i += 2
                    break
                }
                i += 1
            }
            if i >= bytes.count - 1 { i = bytes.count }
            return Data(bytes[start..<i])
        }
    }
}
