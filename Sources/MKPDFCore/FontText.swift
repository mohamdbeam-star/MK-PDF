import Foundation
import CoreGraphics

/// What a font's character codes mean as text: its ToUnicode map first, then (simple fonts) its encoding and glyph
/// names. Text is read straight from the glyphs, so it's right even where PDFKit places a page's text badly.
final class FontText {
    private var map: [Int: String] = [:]
    /// No ToUnicode map and no usable encoding (symbol fonts, Identity CID fonts without a map).
    let unknown: Bool

    init(_ font: CGPDFDictionaryRef, subtype: String, baseFont: String, bytesPerCode: Int) {
        var stream: CGPDFStreamRef?
        if CGPDFDictionaryGetStream(font, "ToUnicode", &stream), let stream {
            var format = CGPDFDataFormat.raw
            if let data = CGPDFStreamCopyData(stream, &format) as Data? { map = Self.parseCMap(data) }
        }
        if !map.isEmpty || bytesPerCode != 1 { unknown = map.isEmpty; return }
        // Simple fonts: base encoding plus Differences.
        let symbolic = baseFont.range(of: "symbol|dingbat|wingding|webding", options: [.regularExpression, .caseInsensitive]) != nil
        var base: [Int: String] = [:]
        var encName: UnsafePointer<CChar>?
        var encDict: CGPDFDictionaryRef?
        var differences: CGPDFArrayRef?
        if CGPDFDictionaryGetName(font, "Encoding", &encName), let encName {
            base = Self.table(String(cString: encName))
        } else if CGPDFDictionaryGetDictionary(font, "Encoding", &encDict), let encDict {
            var b: UnsafePointer<CChar>?
            base = CGPDFDictionaryGetName(encDict, "BaseEncoding", &b) && b != nil ? Self.table(String(cString: b!)) : (symbolic ? [:] : Self.table("StandardEncoding"))
            CGPDFDictionaryGetArray(encDict, "Differences", &differences)
        } else if !symbolic && subtype != "Type3" {
            base = Self.table(subtype == "TrueType" ? "WinAnsiEncoding" : "StandardEncoding")
        }
        map = base
        if let differences {
            var code = 0
            for i in 0..<CGPDFArrayGetCount(differences) {
                var n: CGPDFInteger = 0
                var name: UnsafePointer<CChar>?
                if CGPDFArrayGetInteger(differences, i, &n) { code = Int(n) }
                else if CGPDFArrayGetName(differences, i, &name), let name {
                    if let s = Self.glyphName(String(cString: name)) { map[code] = s } else { map.removeValue(forKey: code) }
                    code += 1
                }
            }
        }
        unknown = map.isEmpty
    }

    func text(_ code: Int) -> String? { map[code] }

    // MARK: ToUnicode CMaps

    static func parseCMap(_ data: Data) -> [Int: String] {
        var out: [Int: String] = [:]
        let s = String(decoding: data, as: UTF8.self)
        // Tokens: <hex>, [ ], and words.
        var tokens: [String] = []
        var i = s.startIndex
        while i < s.endIndex {
            let c = s[i]
            if c == "<" {
                guard let end = s[i...].firstIndex(of: ">") else { break }
                tokens.append(String(s[i...end]).filter { !$0.isWhitespace }); i = s.index(after: end)
            } else if c == "[" || c == "]" { tokens.append(String(c)); i = s.index(after: i) }
            else if c == "%" { i = s[i...].firstIndex(where: { $0 == "\n" || $0 == "\r" }) ?? s.endIndex }
            else if c.isWhitespace { i = s.index(after: i) }
            else {
                let end = s[s.index(after: i)...].firstIndex(where: { $0.isWhitespace || "<[]/".contains($0) }) ?? s.endIndex
                tokens.append(String(s[i..<end])); i = end
            }
        }
        func hex(_ t: String) -> Int? { t.hasPrefix("<") ? Int(t.dropFirst().dropLast(), radix: 16) : nil }
        func utf16(_ t: String) -> String? {
            guard t.hasPrefix("<") else { return nil }
            let h = Array(t.dropFirst().dropLast())
            var units: [UInt16] = []
            var k = 0
            while k + 4 <= h.count { if let u = UInt16(String(h[k..<(k + 4)]), radix: 16) { units.append(u) }; k += 4 }
            if units.isEmpty, h.count == 2, let u = UInt16(String(h), radix: 16) { units = [u] }
            return String(utf16CodeUnits: units, count: units.count)
        }
        var k = 0
        while k < tokens.count {
            if tokens[k] == "beginbfchar" {
                k += 1
                while k + 1 < tokens.count, tokens[k] != "endbfchar" {
                    if let c = hex(tokens[k]), let t = utf16(tokens[k + 1]) { out[c] = t }
                    k += 2
                }
            } else if tokens[k] == "beginbfrange" {
                k += 1
                while k + 2 < tokens.count, tokens[k] != "endbfrange" {
                    guard let lo = hex(tokens[k]), let hi = hex(tokens[k + 1]), hi >= lo, hi - lo < 65_536 else { k += 1; continue }
                    if tokens[k + 2] == "[" {
                        var j = k + 3, c = lo
                        while j < tokens.count, tokens[j] != "]" { if let t = utf16(tokens[j]) { out[c] = t }; c += 1; j += 1 }
                        k = j + 1
                    } else {
                        if var units = utf16(tokens[k + 2]).map({ Array($0.utf16) }), !units.isEmpty {
                            for c in lo...hi {
                                out[c] = String(utf16CodeUnits: units, count: units.count)
                                units[units.count - 1] &+= 1
                            }
                        }
                        k += 3
                    }
                }
            } else { k += 1 }
        }
        return out
    }

    // MARK: Encodings and glyph names

    static func table(_ name: String) -> [Int: String] {
        var out: [Int: String] = [:]
        let encoding: String.Encoding? = name == "WinAnsiEncoding" ? .windowsCP1252 : name == "MacRomanEncoding" ? .macOSRoman : nil
        for code in 32...255 {
            if let encoding {
                if let s = String(bytes: [UInt8(code)], encoding: encoding), s.unicodeScalars.first.map({ $0.value >= 32 }) == true { out[code] = s }
            } else if code < 127 {
                // StandardEncoding: ASCII except the curly single quotes.
                out[code] = code == 0x27 ? "\u{2019}" : code == 0x60 ? "\u{2018}" : String(UnicodeScalar(UInt8(code)))
            }
        }
        if encoding == .windowsCP1252 { out[0xA0] = " "; out[0xAD] = "-" }
        return out
    }

    private static let names: [String: String] = [
        "space": " ", "exclam": "!", "quotedbl": "\"", "numbersign": "#", "dollar": "$", "percent": "%", "ampersand": "&",
        "quotesingle": "'", "parenleft": "(", "parenright": ")", "asterisk": "*", "plus": "+", "comma": ",", "hyphen": "-",
        "period": ".", "slash": "/", "colon": ":", "semicolon": ";", "less": "<", "equal": "=", "greater": ">", "question": "?",
        "at": "@", "bracketleft": "[", "backslash": "\\", "bracketright": "]", "asciicircum": "^", "underscore": "_", "grave": "`",
        "braceleft": "{", "bar": "|", "braceright": "}", "asciitilde": "~", "zero": "0", "one": "1", "two": "2", "three": "3",
        "four": "4", "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9", "bullet": "•", "endash": "–", "emdash": "—",
        "quoteleft": "‘", "quoteright": "’", "quotedblleft": "“", "quotedblright": "”", "quotesinglbase": "‚", "quotedblbase": "„",
        "ellipsis": "…", "fi": "fi", "fl": "fl", "ff": "ff", "ffi": "ffi", "ffl": "ffl", "dagger": "†", "daggerdbl": "‡",
        "trademark": "™", "copyright": "©", "registered": "®", "degree": "°", "sterling": "£", "yen": "¥", "Euro": "€", "euro": "€",
        "cent": "¢", "section": "§", "paragraph": "¶", "periodcentered": "·", "nbspace": " ", "nonbreakingspace": " ", "minus": "−",
        "multiply": "×", "divide": "÷", "plusminus": "±", "guillemotleft": "«", "guillemotright": "»", "guilsinglleft": "‹",
        "guilsinglright": "›", "exclamdown": "¡", "questiondown": "¿", "germandbls": "ß", "ae": "æ", "AE": "Æ", "oe": "œ", "OE": "Œ",
        "oslash": "ø", "Oslash": "Ø", "dotlessi": "ı", "lslash": "ł", "Lslash": "Ł", "eth": "ð", "Eth": "Ð", "thorn": "þ",
        "Thorn": "Þ", "mu": "µ", "onehalf": "½", "onequarter": "¼", "threequarters": "¾", "ordfeminine": "ª", "ordmasculine": "º",
        "brokenbar": "¦", "logicalnot": "¬", "macron": "¯", "acute": "´", "cedilla": "¸", "dieresis": "¨", "florin": "ƒ",
        "perthousand": "‰", "circumflex": "ˆ", "tilde": "˜", "fraction": "⁄", "onesuperior": "¹", "twosuperior": "²",
        "threesuperior": "³", "currency": "¤", "checkmark": "✓",
    ]
    private static let marks: [String: String] = [
        "acute": "\u{301}", "grave": "\u{300}", "circumflex": "\u{302}", "dieresis": "\u{308}", "tilde": "\u{303}",
        "ring": "\u{30A}", "cedilla": "\u{327}", "caron": "\u{30C}", "macron": "\u{304}", "breve": "\u{306}", "ogonek": "\u{328}",
        "dotaccent": "\u{307}", "hungarumlaut": "\u{30B}",
    ]

    /// Unicode for a glyph name: the common Adobe names, uniXXXX / uXXXX[XX], ligatures (f_i) and suffixes (a.sc).
    static func glyphName(_ raw: String) -> String? {
        let name = raw.split(separator: ".").first.map(String.init) ?? raw
        if name.isEmpty { return nil }
        if name.contains("_") {
            let parts = name.split(separator: "_").map { glyphName(String($0)) }
            return parts.contains(where: { $0 == nil }) ? nil : parts.compactMap { $0 }.joined()
        }
        if let s = names[name] { return s }
        if name.count == 1, name.first!.isLetter { return name }
        func scalars(_ hex: Substring, size: Int) -> String? {
            guard hex.count >= 4, hex.count % size == 0 || size == 0 else { return nil }
            var out = ""
            var h = hex
            while !h.isEmpty {
                let chunk = h.prefix(size == 0 ? h.count : size)
                guard let v = UInt32(chunk, radix: 16), let u = UnicodeScalar(v) else { return nil }
                out.unicodeScalars.append(u); h = h.dropFirst(chunk.count)
            }
            return out
        }
        if name.hasPrefix("uni"), let s = scalars(name.dropFirst(3), size: 4) { return s }
        if name.hasPrefix("u"), (5...7).contains(name.count), let s = scalars(name.dropFirst(1), size: 0) { return s }
        // Accented letters: base letter + mark name (eacute, Ccedilla, scaron).
        if let first = name.first, first.isLetter, let mark = marks[String(name.dropFirst())] {
            return (String(first) + mark).precomposedStringWithCanonicalMapping
        }
        return nil
    }
}

extension PageContent {
    /// One line's text read from its glyphs' fonts, with spaces where the font draws one or the gap is a word gap.
    /// Nil when a font doesn't say what its codes mean, or for right-to-left text (PDFKit orders that).
    public func string(of line: [Glyph]) -> String? {
        var out = ""
        var lastEnd: CGFloat?
        for g in line.sorted(by: { $0.rect.minX < $1.rect.minX }) {
            guard knowsText(of: g), var t = text(of: g) else {
                if g.bytes == Data([32]) || g.bytes == Data([0, 3]) || g.bytes == Data([0, 32]) { if !out.hasSuffix(" ") { out += " " }; continue }
                return nil
            }
            if t.unicodeScalars.contains(where: { (0xE000...0xF8FF).contains($0.value) || $0.value == 0xFFFD || $0.value < 32 || (0x0590...0x08FF).contains($0.value) || (0xFB1D...0xFEFF).contains($0.value) }) { return nil }
            // Ligature characters (ﬁ, ﬂ) become their letters, so retyped text uses ordinary characters.
            if t.unicodeScalars.contains(where: { (0xFB00...0xFB06).contains($0.value) }) { t = t.decomposedStringWithCompatibilityMapping }
            if t.allSatisfy(\.isWhitespace) { if !out.hasSuffix(" ") && !out.isEmpty { out += " " }; continue }
            if let e = lastEnd, g.rect.minX - e > CGFloat(g.size) * 0.18, !out.hasSuffix(" ") { out += " " }
            out += t
            lastEnd = max(lastEnd ?? -.infinity, g.rect.maxX)
        }
        let s = out.trimmingCharacters(in: .whitespaces)
        return s.isEmpty ? nil : s
    }

    /// The text of the glyphs whose centres lie in `rect`, line by line (top to bottom); nil when any of it can't be
    /// read from the fonts.
    public func string(in rect: CGRect) -> String? {
        let inside = glyphs.filter { $0.upright && !$0.invisible && rect.contains(CGPoint(x: $0.rect.midX, y: $0.rect.midY)) }
        guard !inside.isEmpty else { return nil }
        var lines: [[Glyph]] = []
        for g in inside.sorted(by: { $0.origin.y > $1.origin.y }) {
            if let last = lines.last?.first, abs(last.origin.y - g.origin.y) < max(1, last.size * 0.3) { lines[lines.count - 1].append(g) } else { lines.append([g]) }
        }
        var parts: [String] = []
        for line in lines {
            // Fragments far apart on one baseline (separate columns) are read left to right with a space.
            guard let s = string(of: line) else { return nil }
            parts.append(s)
        }
        return parts.joined(separator: " ")
    }
}
