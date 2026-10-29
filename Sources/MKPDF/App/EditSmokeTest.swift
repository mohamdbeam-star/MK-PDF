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
        runEditAllIfRequested()
        runExportPagesIfRequested()
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
                print(String(format: "(%.0f,%.0f %.0fx%.0f) %@ %.1fpt lines:%d  %@", b.rect.minX, b.rect.minY, b.rect.width, b.rect.height, b.font.fontName, b.font.pointSize, b.lineRects.count, String(b.text.prefix(70))))
            }
            exit(0)
        }
        // `--glyph-text file.pdf page x y w h`: each glyph in the rect with its font, codes and decoded text.
        if let i = args.firstIndex(of: "--glyph-text"), args.count > i + 6, let doc = PDFDocument(url: URL(fileURLWithPath: args[i + 1])),
           let ref = doc.page(at: (Int(args[i + 2]) ?? 1) - 1)?.pageRef {
            let n = args[(i + 3)...(i + 6)].compactMap { Double($0) }
            let r = CGRect(x: n[0], y: n[1], width: n[2], height: n[3]), content = PageContent(page: ref)
            for g in content.glyphs where r.contains(CGPoint(x: g.rect.midX, y: g.rect.midY)) {
                print(String(format: "%6.1f,%6.1f w%4.1f %@ %@ known:%@ %@", g.rect.minX, g.origin.y, g.rect.width, g.fontResource, g.bytes.map { String(format: "%02X", $0) }.joined(),
                             content.knowsText(of: g) ? "y" : "n", content.text(of: g).map { "'\($0)' " + $0.unicodeScalars.map { String(format: "U+%04X", $0.value) }.joined(separator: " ") } ?? "nil"))
            }
            print("line:", content.string(in: r) ?? "nil")
            exit(0)
        }
        guard let i = args.firstIndex(of: "--edit-coverage") else { return }
        func words(_ s: String) -> [String] { s.split(whereSeparator: { $0.isWhitespace }).map(String.init) }
        for path in args[(i + 1)...] {
            guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else { print("can't open \(path)"); continue }
            var total = 0, found = 0, lines: [String] = []
            for p in 0..<min(doc.pageCount, 20) {
                guard let page = doc.page(at: p), let ref = page.pageRef else { continue }
                let pc = PageContent(page: ref)
                let glyphs = pc.glyphs.filter { !$0.invisible && $0.rect.width > 0.05 && !pc.isBlank($0) }
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

extension EditSmokeTest {
    /// `MKPDF --edit-all out-dir a.pdf b.pdf …`: on the first pages of each file, edits up to eight blocks through the
    /// app's editing path (appending a marker), then checks that each edit is page text that's editable again, that
    /// the rest of the page's text is still there and that nothing outside the edited blocks changed. Saves each result.
    static func runEditAllIfRequested() {
        let args = CommandLine.arguments
        guard let i = args.firstIndex(of: "--edit-all"), args.count > i + 2 else { return }
        let outDir = URL(fileURLWithPath: args[i + 1])
        try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
        func words(_ page: PDFPage) -> [String] {
            ContentEditor.blocks(on: page).flatMap { $0.text.split(whereSeparator: \.isWhitespace).map(String.init) }
        }
        func pixels(_ page: PDFPage) -> (img: CGImage, data: [UInt8])? {
            guard let img = PageRenderer.image(of: page, dpi: 72) else { return nil }
            var data = [UInt8](repeating: 0, count: img.width * img.height * 4)
            guard let ctx = CGContext(data: &data, width: img.width, height: img.height, bitsPerComponent: 8, bytesPerRow: img.width * 4,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
            ctx.draw(img, in: CGRect(x: 0, y: 0, width: img.width, height: img.height))
            return (img, data)
        }
        for path in args[(i + 2)...] {
            let name = (path as NSString).lastPathComponent
            guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else { print("\(name): can't open"); continue }
            if doc.isLocked { print("\(name): password protected"); continue }
            let editor = EditorModel(document: PDFFileDocument())
            editor.document.pdf = doc
            var report: [String] = []
            var tried = 0, landed = 0, reEditable = 0, lostWords = 0, noBlocks = 0, scans = 0, collateral: [String] = [], fonts: [String: Int] = [:]
            for p in 0..<min(doc.pageCount, 3) {
                guard var page = doc.page(at: p) else { continue }
                var blocks = ContentEditor.blocks(on: page).filter { !$0.scanned }
                if blocks.isEmpty {
                    // A scan: "Make This Page Editable" (OCR), then edit the recognised lines.
                    if page.rotation % 360 != 0 { page = PageCompositor.upright(page); doc.replacePage(at: p, with: page) }
                    guard let lines = try? OCR.recognize(page, language: nil, accurate: true), !lines.isEmpty,
                          let composed = PageCompositor.compose(page, overlay: { OCR.drawInvisibleText(lines, in: $0) }) else { noBlocks += 1; continue }
                    doc.replacePage(at: p, with: composed)
                    page = composed
                    blocks = ContentEditor.blocks(on: page)
                    scans += 1
                    if blocks.isEmpty { noBlocks += 1; continue }
                }
                let before = pixels(page)
                let crop = page.bounds(for: .cropBox)
                // A spread of blocks: the longest, then evenly through the rest.
                let sorted = blocks.sorted { $0.text.count > $1.text.count }
                let step = max(1, sorted.count / 8)
                let picks = Array(stride(from: 0, to: sorted.count, by: step).prefix(8).map { sorted[$0] })
                let allWords = words(page)
                var touched: [CGRect] = [], removedWords: [String] = []
                for (k, original) in picks.enumerated() {
                    guard let current = doc.page(at: p),
                          let block = ContentEditor.blocks(on: current).first(where: { abs($0.rect.minX - original.rect.minX) < 1 && abs($0.rect.maxY - original.rect.maxY) < 1 && $0.text == original.text }) else { continue }
                    tried += 1
                    let marker = "QZ\(p)\(k)"
                    let text = block.text + " " + marker
                    fonts[block.font.fontName, default: 0] += 1
                    editor.commitTextEdit(page: current, original: block, text: text, font: block.font, color: block.color, alignment: block.alignment,
                                          at: CGPoint(x: block.rect.minX, y: block.firstBaseline), width: block.wrapWidth, box: block.rect.width)
                    removedWords += block.text.split(whereSeparator: \.isWhitespace).map(String.init)
                    touched.append(CGRect(x: block.rect.minX - 2, y: block.rect.minY - block.pitch * 2 - 2, width: max(block.rect.width, 60) + 60, height: block.rect.height + block.pitch * 2 + 4))
                    guard let edited = doc.page(at: p) else { continue }
                    if (edited.string ?? "").contains(marker) { landed += 1 } else { report.append("   p\(p + 1) not page text after edit: \(block.text.prefix(40))") }
                    if ContentEditor.blocks(on: edited).contains(where: { $0.text.contains(marker) }) { reEditable += 1 }
                    else { report.append("   p\(p + 1) not editable again: \(block.text.prefix(40))") }
                }
                // Every word that wasn't in an edited block must still be on the page.
                guard let final = doc.page(at: p) else { continue }
                var bag: [String: Int] = [:]
                for w in words(final) { bag[w, default: 0] += 1 }
                var expected: [String: Int] = [:]
                for w in allWords { expected[w, default: 0] += 1 }
                for w in removedWords { expected[w, default: 0] -= 1 }
                let lost = expected.filter { $0.value > 0 && (bag[$0.key] ?? 0) < $0.value }.map(\.key)
                lostWords += lost.count
                if !lost.isEmpty { report.append("   p\(p + 1) lost words: \(lost.prefix(10).joined(separator: " "))") }
                // Pixels outside the edited blocks must be unchanged.
                if let a = before, let b = pixels(final), a.img.width == b.img.width, a.img.height == b.img.height {
                    let w = a.img.width, h = a.img.height, sx = CGFloat(w) / crop.width, sy = CGFloat(h) / crop.height
                    var changed = 0, outside = 0
                    for y in 0..<h { for x in 0..<w {
                        let pt = CGPoint(x: crop.minX + (CGFloat(x) + 0.5) / sx, y: crop.maxY - (CGFloat(y) + 0.5) / sy)
                        if touched.contains(where: { $0.contains(pt) }) { continue }
                        outside += 1
                        let o = (y * w + x) * 4
                        if abs(Int(a.data[o]) - Int(b.data[o])) + abs(Int(a.data[o + 1]) - Int(b.data[o + 1])) + abs(Int(a.data[o + 2]) - Int(b.data[o + 2])) > 60 { changed += 1 }
                    } }
                    let share = Double(changed) / Double(max(outside, 1)) * 100
                    if share > 0.2 { collateral.append(String(format: "p%d %.1f%%", p + 1, share)) }
                }
            }
            let out = outDir.appendingPathComponent(name)
            let saved = (try? PDFExporter.data(for: doc).write(to: out)) != nil && PDFDocument(url: out) != nil
            print(String(format: "%@: edits %d/%d landed, %d re-editable, lost words %d, scanned pages %d, pages without text %d, changed elsewhere [%@], saved %@, fonts %@",
                         name, landed, tried, reEditable, lostWords, scans, noBlocks, collateral.joined(separator: " "), saved ? "ok" : "FAILED",
                         fonts.sorted { $0.value > $1.value }.prefix(3).map { "\($0.key)" }.joined(separator: ",")))
            report.prefix(6).forEach { print($0) }
        }
        exit(0)
    }
}

extension EditSmokeTest {
    /// `MKPDF --export-pages out-dir a.pdf …`: converts each of the first three pages of each file to Word on its own
    /// (out-dir/<name>-p<n>.docx) with the app's converter, for page-by-page comparison with the original.
    static func runExportPagesIfRequested() {
        let args = CommandLine.arguments
        guard let i = args.firstIndex(of: "--export-pages"), args.count > i + 2 else { return }
        let outDir = URL(fileURLWithPath: args[i + 1])
        try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
        for path in args[(i + 2)...] {
            let name = ((path as NSString).lastPathComponent as NSString).deletingPathExtension
            guard let doc = PDFDocument(url: URL(fileURLWithPath: path)), !doc.isLocked else { print("\(name): can't open"); continue }
            for p in 0..<min(doc.pageCount, 3) {
                guard let page = doc.page(at: p), let copy = PDFExporter.copy(of: doc) else { continue }
                // A one-page document holding just this page.
                while copy.pageCount > p + 1 { copy.removePage(at: copy.pageCount - 1) }
                while copy.pageCount > 1 { copy.removePage(at: 0) }
                _ = page
                let t0 = Date()
                // As the export panel does with "Recognize text in scanned pages": OCR a page with no text first.
                if let only = copy.page(at: 0), (only.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    let upright = PageCompositor.upright(only)
                    if let lines = try? OCR.recognize(upright, language: nil, accurate: true).filter({ !$0.handwritten }), !lines.isEmpty,
                       let composed = PageCompositor.compose(upright, overlay: { OCR.drawInvisibleText(lines, in: $0) }) {
                        copy.replacePage(at: 0, with: composed)
                    }
                }
                do {
                    let data = try CoreConverter.convert(copy, format: "docx", title: name)
                    try data.write(to: outDir.appendingPathComponent("\(name)-p\(p + 1).docx"))
                    print(String(format: "%@ p%d: %d bytes in %.1fs", name, p + 1, data.count, Date().timeIntervalSince(t0)))
                } catch { print("\(name) p\(p + 1): FAILED \(error.localizedDescription)") }
            }
        }
        exit(0)
    }
}

