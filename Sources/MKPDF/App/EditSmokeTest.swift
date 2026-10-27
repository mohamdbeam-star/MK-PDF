import AppKit
import PDFKit
import MKPDFCore

/// `MKPDF --edit-smoke-test in.pdf out.pdf` runs the Edit Text & Images pipeline without UI:
/// lists text blocks, rewrites the first paragraph, moves the first image and saves. Used to verify releases.
enum EditSmokeTest {
    static func runIfRequested() {
        // `--copy-page-test in.pdf out.pdf`: rewrites page 1 with the content engine (no change) and saves.
        if let i = CommandLine.arguments.firstIndex(of: "--copy-page-test"), CommandLine.arguments.count > i + 2,
           let doc = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[i + 1])), let page = doc.page(at: 0),
           let copy = ContentEditor.rewrite(page, edit: { _ in }) {
            doc.replacePage(at: 0, with: copy)
            try? PDFExporter.data(for: doc).write(to: URL(fileURLWithPath: CommandLine.arguments[i + 2]))
            exit(0)
        }
        runFeatureTestIfRequested()
        runScanTestIfRequested()
        runEditCoverageIfRequested()
        UpdateChecker.shared.runInstallTestIfRequested()
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

extension EditSmokeTest {
    /// `MKPDF --scan-edit-smoke-test in.pdf out.pdf "old words" "new text"` recognises page 1, edits the block
    /// containing the old words like the editor does, saves, and writes out.png (the edited page).
    static func runScanTestIfRequested() {
        let args = CommandLine.arguments
        guard let i = args.firstIndex(of: "--scan-edit-smoke-test"), args.count > i + 4 else { return }
        let output = URL(fileURLWithPath: args[i + 2])
        guard let doc = PDFDocument(url: URL(fileURLWithPath: args[i + 1])), let page = doc.page(at: 0) else { print("can't open"); exit(1) }
        do {
            let lines = try OCR.recognize(page, language: nil, accurate: true)
            print("recognised lines:", lines.count)
            guard let composed = PageCompositor.compose(page, overlay: { OCR.drawInvisibleText(lines, in: $0) }) else { print("compose failed"); exit(1) }
            doc.replacePage(at: 0, with: composed)
            let editor = EditorModel(document: PDFFileDocument())
            editor.document.pdf = doc
            let blocks = ContentEditor.blocks(on: composed)
            print("blocks:", blocks.count, "scanned:", blocks.filter(\.scanned).count)
            guard let target = blocks.first(where: { $0.text.contains(args[i + 3]) }) else { print("no block with", args[i + 3]); exit(1) }
            print("editing:", target.text, "size", target.font.pointSize)
            editor.commitTextEdit(page: composed, original: target, text: target.text.replacingOccurrences(of: args[i + 3], with: args[i + 4]),
                                  font: target.font, color: target.color, alignment: target.alignment,
                                  at: CGPoint(x: target.rect.minX, y: target.firstBaseline), width: target.isMultiline ? target.rect.width + 2 : nil, box: target.rect.width)
            try PDFExporter.data(for: doc).write(to: output)
            if let edited = PDFDocument(url: output)?.page(at: 0), let img = PageRenderer.image(of: edited, dpi: 110) {
                try NSBitmapImageRep(cgImage: img).representation(using: .png, properties: [:])?.write(to: output.deletingPathExtension().appendingPathExtension("png"))
            }
            exit(0)
        } catch { print(error); exit(1) }
    }

    /// `MKPDF --feature-smoke-test in.pdf outdir` writes Excel, PowerPoint, extracted images, a repaired copy,
    /// and checks the update version logic.
    static func runFeatureTestIfRequested() {
        let args = CommandLine.arguments
        guard let i = args.firstIndex(of: "--feature-smoke-test"), args.count > i + 2 else { return }
        let input = URL(fileURLWithPath: args[i + 1]), out = URL(fileURLWithPath: args[i + 2], isDirectory: true)
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        guard let doc = PDFDocument(url: input) else { print("can't open"); exit(1) }
        for row in doc.page(at: 0).map(ContentEditor.table(on:)) ?? [] { print("row:", row) }
        for f in [ExportFormat.word, .word97, .odt, .rtf, .text, .markdown, .html, .csv, .excel, .powerpoint] {
            let start = Date()
            do {
                let data = try f.render(doc, title: input.lastPathComponent)
                try data.write(to: out.appendingPathComponent("out.\(f.fileExtension)"))
                print(String(format: "export %@ %d bytes %.2fs", f.fileExtension, data.count, Date().timeIntervalSince(start)))
            } catch { print("export \(f.fileExtension) failed: \(error)") }
        }
        print("images:", (try? ImageExtractor.extract(doc, to: out, name: "img")) ?? -1)
        let batchDir = out.appendingPathComponent("batch")
        try? FileManager.default.createDirectory(at: batchDir, withIntermediateDirectories: true)
        let group = DispatchGroup()
        group.enter()
        Task { @MainActor in
            for op in BatchView.Operation.allCases {
                do {
                    try await BatchJob(operation: op, password: "test1234").process(input, into: batchDir)
                    print("batch ✓", op.rawValue)
                } catch { print("batch ✗", op.rawValue, error.localizedDescription) }
            }
            group.leave()
        }
        while group.wait(timeout: .now()) == .timedOut { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
        print("newer 1.10.0>1.9.2:", UpdateChecker.isNewer("1.10.0", than: "1.9.2"), " 1.1.0>1.1.0:", UpdateChecker.isNewer("1.1.0", than: "1.1.0"))
        let sample = #"{"tag_name":"v1.2.0","html_url":"https://github.com/x/y/releases/tag/v1.2.0","body":"Notes","assets":[{"name":"MK-PDF-1.2.0.dmg","browser_download_url":"https://github.com/x/y/releases/download/v1.2.0/MK-PDF-1.2.0.dmg"}]}"#
        print("parsed:", UpdateChecker.parse(Data(sample.utf8)).map { "\($0.version) \($0.dmg?.lastPathComponent ?? "-")" } ?? "nil")
        exit(0)
    }
}

extension EditSmokeTest {
    /// `MKPDF --edit-coverage a.pdf b.pdf …`: for each page, how much of the page's text Edit Text & Images offers as
    /// editable blocks, with a sample of the words it misses (debug aid for the block finder).
    static func runEditCoverageIfRequested() {
        let args = CommandLine.arguments
        // `--edit-blocks file.pdf page`: lists the editable blocks of one page.
        if let i = args.firstIndex(of: "--edit-blocks"), args.count > i + 2, let doc = PDFDocument(url: URL(fileURLWithPath: args[i + 1])),
           let page = doc.page(at: (Int(args[i + 2]) ?? 1) - 1) {
            for b in ContentEditor.blocks(on: page) {
                print(String(format: "(%.0f,%.0f %.0fx%.0f) %.1fpt lines:%d  %@", b.rect.minX, b.rect.minY, b.rect.width, b.rect.height, b.font.pointSize, b.lineRects.count, String(b.text.prefix(70))))
            }
            exit(0)
        }
        guard let i = args.firstIndex(of: "--edit-coverage") else { return }
        func words(_ s: String) -> [String] { s.split(whereSeparator: { $0.isWhitespace }).map(String.init) }
        for path in args[(i + 1)...] {
            guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else { print("can't open \(path)"); continue }
            var total = 0, found = 0, lines: [String] = []
            for p in 0..<min(doc.pageCount, 20) {
                guard let page = doc.page(at: p), let ref = page.pageRef else { continue }
                let glyphs = PageContent(page: ref).glyphs.filter { !$0.invisible && $0.rect.width > 0.05 && $0.bytes != Data([32]) && $0.bytes != Data([0, 3]) && $0.bytes != Data([0, 32]) }
                guard !glyphs.isEmpty else { continue }
                let rects = ContentEditor.blocks(on: page).flatMap(\.lineRects).map { $0.insetBy(dx: -1, dy: -1) }
                let missed = glyphs.filter { g in !rects.contains { $0.contains(CGPoint(x: g.rect.midX, y: g.rect.midY)) } }
                total += glyphs.count; found += glyphs.count - missed.count
                let share = Double(glyphs.count - missed.count) / Double(glyphs.count)
                if share < 0.97 {
                    let upright = missed.filter(\.upright).count
                    let where_ = missed.prefix(6).map { String(format: "(%.0f,%.0f %@)", $0.rect.minX, $0.rect.minY, page.selection(for: $0.rect.insetBy(dx: -0.5, dy: -0.5))?.string ?? "?") }
                    lines.append(String(format: "   p%d %3.0f%%  missed %d (%d upright)  %@", p + 1, share * 100, missed.count, upright, where_.joined(separator: " ")))
                }
            }
            print(String(format: "%3.0f%%  %@", total == 0 ? 100 : Double(found) / Double(total) * 100, (path as NSString).lastPathComponent))
            lines.prefix(4).forEach { print($0) }
        }
        exit(0)
    }
}
