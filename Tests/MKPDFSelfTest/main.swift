import Foundation
import PDFKit
import CoreText
import MKPDFCore

// Checks the content engine against PDFs written two ways: by hand (standard fonts, Tj/TJ/'/" operators)
// and by Quartz/Core Text (embedded subset fonts), plus images.

var failures = 0
func check(_ condition: Bool, _ message: String) {
    print(condition ? "  ✓ \(message)" : "  ✗ \(message)")
    if !condition { failures += 1 }
}

func handWrittenPDF() -> Data {
    let content = """
    BT /F1 14 Tf 72 700 Td (Invoice number 1234 is secret data) Tj ET
    BT /F1 12 Tf 14 TL 72 660 Td [(Kerned) -250 (words) 120 (here)] TJ (Next line follows) ' 2 0.5 (Spaced line) " ET
    q 100 0 0 50 300 500 cm /Im1 Do Q
    BT /F2 10 Tf 72 400 Td (Courier text stays) Tj ET
    """
    var objects: [String] = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 7 0 R >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
    ]
    let pixels = String(repeating: "FF0000", count: 4)
    objects.append("<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length \(pixels.count + 1) >>\nstream\n\(pixels)>\nendstream")
    objects.append("<< /Length \(content.utf8.count) >>\nstream\n\(content)\nendstream")
    var out = "%PDF-1.4\n"
    var offsets: [Int] = []
    for (i, o) in objects.enumerated() {
        offsets.append(out.utf8.count)
        out += "\(i + 1) 0 obj\n\(o)\nendobj\n"
    }
    let xref = out.utf8.count
    out += "xref\n0 \(objects.count + 1)\n0000000000 65535 f \n" + offsets.map { String(format: "%010d 00000 n \n", $0) }.joined()
    out += "trailer\n<< /Size \(objects.count + 1) /Root 1 0 R >>\nstartxref\n\(xref)\n%%EOF\n"
    return Data(out.utf8)
}

func quartzPDF() -> Data {
    let data = NSMutableData()
    var box = CGRect(x: 0, y: 0, width: 612, height: 792)
    let ctx = CGContext(consumer: CGDataConsumer(data: data as CFMutableData)!, mediaBox: &box, nil)!
    ctx.beginPDFPage(nil)
    func line(_ s: String, _ y: CGFloat, _ font: String, _ size: CGFloat) {
        let f = CTFontCreateWithName(font as CFString, size, nil)
        let l = CTLineCreateWithAttributedString(NSAttributedString(string: s, attributes: [.font: f]))
        ctx.textPosition = CGPoint(x: 72, y: y)
        CTLineDraw(l, ctx)
    }
    line("Quarterly report draft for review", 700, "Helvetica", 16)
    line("Total amount due: 5,400 AED", 670, "Times New Roman", 13)
    line("Prepared by the finance team", 640, "Georgia", 12)
    line("مرحبا بالعالم", 600, "Geeza Pro", 14)
    ctx.endPDFPage()
    ctx.closePDF()
    return data as Data
}

func words(_ page: PDFPage) -> String { (page.string ?? "").replacingOccurrences(of: "\n", with: " ") }

func bounds(of text: String, in doc: PDFDocument) -> CGRect? {
    guard let sel = doc.findString(text, withOptions: []).first, let p = sel.pages.first else { return nil }
    return sel.bounds(for: p)
}

func render(_ page: CGPDFPage) -> [UInt8] {
    let w = 306, h = 396
    var px = [UInt8](repeating: 0, count: w * h * 4)
    let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.setFillColor(.white)
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    ctx.scaleBy(x: 0.5, y: 0.5)
    ctx.drawPDFPage(page)
    return px
}

func difference(_ a: [UInt8], _ b: [UInt8]) -> Double {
    var total = 0
    for i in 0..<min(a.count, b.count) { total += abs(Int(a[i]) - Int(b[i])) }
    return Double(total) / Double(a.count)
}

func cgPage(_ data: Data) -> CGPDFPage? { CGPDFDocument(CGDataProvider(data: data as CFData)!)?.page(at: 1) }

// MARK: - Real files: `swift run MKPDFSelfTest a.pdf b.pdf` round-trips every page and removes one word.

if CommandLine.arguments.count > 1 {
    for path in CommandLine.arguments.dropFirst() {
        let url = URL(fileURLWithPath: path)
        guard let doc = CGPDFDocument(url as CFURL), let pdf = PDFDocument(url: url) else { print("skip \(url.lastPathComponent)"); continue }
        var worst = 0.0, textOK = 0, removedOK = 0, pages = min(doc.numberOfPages, 6)
        let start = Date()
        for n in 1...max(1, pages) {
            guard let page = doc.page(at: n), let data = PageContent(page: page).pdfData(), let out = cgPage(data) else { continue }
            worst = max(worst, difference(render(page), render(out)))
            if n == 1, let dump = ProcessInfo.processInfo.environment["DUMP"] { try? data.write(to: URL(fileURLWithPath: dump)) }
            if words(PDFDocument(data: data)!.page(at: 0)!) == words(pdf.page(at: n - 1)!) { textOK += 1 }
            // Remove the first longer word on the page.
            if let word = words(pdf.page(at: n - 1)!).split(separator: " ").first(where: { $0.count >= 5 && $0.allSatisfy(\.isLetter) }),
               let rect = bounds(of: String(word), in: PDFDocument(data: PDFWriter.page(from: page, content: PDFWriter.contentData(of: page)) ?? Data()) ?? pdf) {
                let edit = PageContent(page: page)
                edit.removeText(in: [rect.insetBy(dx: -0.5, dy: -0.5)])
                if let d = edit.pdfData(), let after = PDFDocument(data: d)?.page(at: 0) {
                    let before = words(pdf.page(at: n - 1)!).components(separatedBy: String(word)).count
                    if words(after).components(separatedBy: String(word)).count < before { removedOK += 1 }
                }
            } else { removedOK += 1 }
        }
        print(String(format: "%@: %d pages, max render diff %.2f, text identical %d/%d, word removal %d/%d, %.1fs",
                     url.lastPathComponent, pages, worst, textOK, pages, removedOK, pages, Date().timeIntervalSince(start)))
    }
    exit(0)
}

// MARK: - Tests

print("Parsing")
let parsed = ContentStream.parse(Data("BT /F1 12 Tf (a\\(b\\)c) Tj [(x) -20 <0041>] TJ ET BI /W 1 /H 1 /CS /G /BPC 8 ID \u{7F} EI Q".utf8))
check(parsed.map(\.op) == ["BT", "Tf", "Tj", "TJ", "ET", "BI", "Q"], "tokenizes operators, strings, arrays and inline images")
check(parsed[2].operands.first == .string(Data("a(b)c".utf8)), "decodes escaped literal strings")

for (label, data) in [("hand-written PDF", handWrittenPDF()), ("Quartz PDF", quartzPDF())] {
    print("\(label)")
    guard let page = cgPage(data), let original = PDFDocument(data: data) else { check(false, "loads"); continue }

    // Round trip with no edits must look identical.
    let content = PageContent(page: page)
    check(!content.glyphs.isEmpty, "finds \(content.glyphs.count) glyphs")
    guard let same = content.pdfData(), let samePage = cgPage(same) else { check(false, "writes page"); continue }
    check(difference(render(page), render(samePage)) < 0.5, "rewritten page renders the same")
    check(words(PDFDocument(data: same)!.page(at: 0)!) == words(original.page(at: 0)!), "rewritten page has the same text")

    // Remove one word; everything else must stay put.
    let target = label == "Quartz PDF" ? "draft" : "secret"
    let keep = label == "Quartz PDF" ? "review" : "data"
    guard let targetRect = bounds(of: target, in: original), let keepBefore = bounds(of: keep, in: original) else { check(false, "finds test words"); continue }
    let edit = PageContent(page: page)
    let removed = edit.removeText(in: [targetRect.insetBy(dx: -0.5, dy: -0.5)])
    check(removed == target.count, "removes \(removed) glyphs of “\(target)”")
    guard let editedData = edit.pdfData(), let edited = PDFDocument(data: editedData) else { check(false, "writes edited page"); continue }
    let text = words(edited.page(at: 0)!)
    check(!text.contains(target), "“\(target)” is gone from the text layer")
    check(text.contains(keep), "“\(keep)” is still there")
    if let keepAfter = bounds(of: keep, in: edited) {
        check(abs(keepAfter.minX - keepBefore.minX) < 0.6 && abs(keepAfter.minY - keepBefore.minY) < 0.6,
              "following text did not move (Δx \(String(format: "%.2f", keepAfter.minX - keepBefore.minX)))")
    } else {
        check(false, "finds “\(keep)” after the edit")
    }
}

print("Objects")
if let page = cgPage(handWrittenPDF()) {
    let content = PageContent(page: page)
    check(content.objects.count == 1 && content.objects[0].bounds.equalTo(CGRect(x: 300, y: 500, width: 100, height: 50)), "locates the image")
    content.transformObject(content.objects[0], to: CGRect(x: 100, y: 100, width: 200, height: 80))
    let moved = content.objects.first?.bounds ?? .null
    check(abs(moved.minX - 100) < 0.01 && abs(moved.width - 200) < 0.01 && abs(moved.height - 80) < 0.01, "moves and resizes the image")
    let movedPage = content.pdfData().flatMap(cgPage)
    check(movedPage.map { PageContent(page: $0).objects.first?.bounds.minY ?? 0 } == 100, "move survives writing")
    content.removeObject(content.objects[0])
    check(content.objects.isEmpty, "deletes the image")
}

print("Overlay merge (new text added without re-drawing the page)")
if let page = cgPage(handWrittenPDF()) {
    let original = PDFWriter.contentData(of: page)
    var box = page.getBoxRect(.mediaBox)
    let layer = NSMutableData()
    let ctx = CGContext(consumer: CGDataConsumer(data: layer as CFMutableData)!, mediaBox: &box, nil)!
    ctx.beginPDFPage(nil)
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: "Added by overlay", attributes: [.font: CTFontCreateWithName("Helvetica" as CFString, 14, nil)]))
    ctx.textPosition = CGPoint(x: 72, y: 100)
    CTLineDraw(line, ctx)
    ctx.endPDFPage()
    ctx.closePDF()
    if let overlay = cgPage(layer as Data), let merged = PDFWriter.page(from: page, content: original, overlay: overlay), let doc = PDFDocument(data: merged),
       let mergedPage = cgPage(merged) {
        let content = PDFWriter.contentData(of: mergedPage)
        check(content.range(of: original) != nil, "keeps the original content byte for byte")
        check(words(doc.page(at: 0)!).contains("Added by overlay"), "the new text is real text")
        check(PageContent(page: mergedPage).glyphs.count > PageContent(page: page).glyphs.count, "the new text is editable page text")
    } else {
        check(false, "merges the overlay")
    }
}

print("Text read from the fonts (ToUnicode maps, encodings)")
if let page = cgPage(quartzPDF()) {
    let content = PageContent(page: page)
    check(content.string(in: CGRect(x: 60, y: 695, width: 500, height: 12)) == "Quarterly report draft for review", "ToUnicode text of a Quartz PDF")
    check(content.string(in: CGRect(x: 60, y: 666, width: 500, height: 10)) == "Total amount due: 5,400 AED", "punctuation and digits")
    check(content.string(in: CGRect(x: 60, y: 596, width: 500, height: 10)) == nil, "right-to-left text is left to PDFKit")
}
if let page = cgPage(handWrittenPDF()) {
    let content = PageContent(page: page)
    check(content.string(in: CGRect(x: 60, y: 698, width: 500, height: 10)) == "Invoice number 1234 is secret data", "WinAnsi simple font without a ToUnicode map")
    check(content.string(in: CGRect(x: 60, y: 398, width: 500, height: 8)) == "Courier text stays", "standard encoding")
    check(content.string(in: CGRect(x: 60, y: 658, width: 500, height: 8))?.hasPrefix("Kerned words") == true, "a wide TJ gap is a word space")
}

print(failures == 0 ? "\nAll checks passed" : "\n\(failures) check(s) failed")
exit(failures == 0 ? 0 : 1)
