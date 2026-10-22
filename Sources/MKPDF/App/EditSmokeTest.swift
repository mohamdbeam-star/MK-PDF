import AppKit
import PDFKit
import MKPDFCore

/// `MKPDF --edit-smoke-test in.pdf out.pdf` runs the Edit Text & Images pipeline without UI:
/// lists text blocks, rewrites the first paragraph, moves the first image and saves. Used to verify releases.
enum EditSmokeTest {
    static func runIfRequested() {
        let args = CommandLine.arguments
        guard let i = args.firstIndex(of: "--edit-smoke-test"), args.count > i + 2 else { return }
        let input = URL(fileURLWithPath: args[i + 1]), output = URL(fileURLWithPath: args[i + 2])
        guard let doc = PDFDocument(url: input), let page = doc.page(at: 0) else { print("can't open"); exit(1) }
        let editor = EditorModel(document: PDFFileDocument())
        editor.document.pdf = doc
        let blocks = ContentEditor.blocks(on: page)
        for b in blocks { print(String(format: "block (%.0f,%.0f %.0fx%.0f) %@ %.1fpt lines:%d  %@", b.rect.minX, b.rect.minY, b.rect.width, b.rect.height, b.font.fontName, b.font.pointSize, b.lineRects.count, String(b.text.prefix(60)))) }
        let objects = ContentEditor.objects(on: page)
        for o in objects { print("object \(o.kind) \(o.bounds)") }

        // Edit the paragraph containing "enquiry" (or the third block).
        if let target = blocks.first(where: { $0.text.contains("enquiry") }) ?? blocks.dropFirst(2).first {
            var newText = target.text.replacingOccurrences(of: "ten working days", with: "five working days").replacingOccurrences(of: "thirty", with: "sixty")
            if newText == target.text { newText = "EDITED BY MK PDF — " + newText }
            editor.commitTextEdit(page: page, original: target, text: newText, font: target.font, color: target.color,
                                  alignment: target.alignment, at: CGPoint(x: target.rect.minX, y: target.firstBaseline),
                                  width: target.isMultiline ? target.rect.width + 2 : nil, box: target.rect.width)
        }
        // Change a single-line block (the total) and move it right.
        if let p = doc.page(at: 0), let total = ContentEditor.blocks(on: p).first(where: { $0.text.hasPrefix("Total") }) {
            editor.commitTextEdit(page: p, original: total, text: "Total: 9,450 AED", font: total.font, color: .systemRed,
                                  alignment: .left, at: CGPoint(x: total.rect.minX + 200, y: total.firstBaseline), width: nil)
        }
        // Move and enlarge the first image.
        if let p = doc.page(at: 0), let obj = ContentEditor.objects(on: p).first {
            editor.moveObject(obj, on: p, to: CGRect(x: 60, y: 300, width: obj.bounds.width * 1.5, height: obj.bounds.height * 1.5))
        }
        do {
            try PDFExporter.data(for: doc).write(to: output)
            print("text after edit:\n" + (PDFDocument(url: output)?.page(at: 0)?.string ?? ""))
            exit(0)
        } catch {
            print(error)
            exit(1)
        }
    }
}
