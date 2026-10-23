import SwiftUI
import PDFKit
import CoreText

enum PageText {
    /// Draws `text` in display space (upright on the page as shown) with its box anchored by `anchor` (0…1).
    static func draw(_ text: String, in ctx: CGContext, page: PDFPage, at point: CGPoint, anchor: CGPoint,
                     font: NSFont, color: NSColor, angle: CGFloat = 0, opacity: CGFloat = 1) {
        let attributed = NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color])
        let line = CTLineCreateWithAttributedString(attributed)
        var ascent: CGFloat = 0, descent: CGFloat = 0
        let width = CGFloat(CTLineGetTypographicBounds(line, &ascent, &descent, nil))
        ctx.saveGState()
        ctx.concatenate(page.displayToPage)
        ctx.setAlpha(opacity)
        ctx.translateBy(x: point.x, y: point.y)
        ctx.rotate(by: angle * .pi / 180)
        ctx.textMatrix = .identity
        ctx.textPosition = CGPoint(x: -width * anchor.x, y: -(ascent + descent) * anchor.y + descent)
        CTLineDraw(line, ctx)
        ctx.restoreGState()
    }

    static func expand(_ template: String, page: Int, pages: Int, file: String) -> String {
        template
            .replacingOccurrences(of: "{page}", with: "\(page)")
            .replacingOccurrences(of: "{pages}", with: "\(pages)")
            .replacingOccurrences(of: "{date}", with: Date().formatted(date: .numeric, time: .omitted))
            .replacingOccurrences(of: "{file}", with: file)
    }
}

struct WatermarkSheet: View {
    @ObservedObject var editor: EditorModel
    @Environment(\.dismiss) private var dismiss
    @State private var text = "CONFIDENTIAL"
    @State private var size = 72.0
    @State private var opacity = 0.18
    @State private var angle = 45.0
    @State private var color = Color.red
    @State private var range = ""
    @State private var image: NSImage?
    @State private var useImage = false

    var body: some View {
        Form {
            Text("Watermark").font(.title2.bold())
            Picker("Type", selection: $useImage) {
                Text("Text").tag(false)
                Text("Image").tag(true)
            }
            .pickerStyle(.segmented)
            if useImage {
                HStack {
                    if let image { Image(nsImage: image).resizable().aspectRatio(contentMode: .fit).frame(height: 40) }
                    Button(image == nil ? "Choose Image…" : "Change…") {
                        image = Panels.open(Panels.imageTypes).first.flatMap(NSImage.init(contentsOf:))
                    }
                }
            }
            TextField("Text", text: $text).disabled(useImage)
            Slider(value: $size, in: 18...160) { Text("Size \(Int(size))") }
            Slider(value: $opacity, in: 0.05...1) { Text("Opacity \(Int(opacity * 100))%") }
            Slider(value: $angle, in: -90...90, step: 5) { Text("Angle \(Int(angle))°") }
            ColorPicker("Color", selection: $color)
            TextField("Pages (blank = all)", text: $range, prompt: Text("e.g. 1-3, 5"))
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Apply") { apply() }.keyboardShortcut(.defaultAction).disabled(useImage ? image == nil : text.isEmpty)
            }
        }
        .padding(22)
        .frame(width: 420)
    }

    private func apply() {
        let indices = range.isEmpty ? nil : PageRanges.parse(range, pageCount: editor.pageCount)
        if !range.isEmpty && indices == nil { return Panels.alert("Check the page range") }
        let font = NSFont.systemFont(ofSize: size, weight: .bold)
        let nsColor = NSColor(color)
        editor.transformPages("Add Watermark", indices: indices) { page, _ in
            PageCompositor.compose(page) { ctx in
                let s = page.displaySize
                if useImage, let image {
                    // Size slider sets the image width as a share of the page.
                    let w = s.width * CGFloat(size) / 160, h = image.size.width > 0 ? w * image.size.height / image.size.width : w
                    ctx.saveGState()
                    ctx.concatenate(page.displayToPage)
                    ctx.setAlpha(opacity)
                    ctx.translateBy(x: s.width / 2, y: s.height / 2)
                    ctx.rotate(by: angle * .pi / 180)
                    NSGraphicsContext.saveGraphicsState()
                    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
                    image.draw(in: CGRect(x: -w / 2, y: -h / 2, width: w, height: h))
                    NSGraphicsContext.restoreGraphicsState()
                    ctx.restoreGState()
                } else {
                    PageText.draw(text, in: ctx, page: page, at: CGPoint(x: s.width / 2, y: s.height / 2), anchor: CGPoint(x: 0.5, y: 0.5),
                                  font: font, color: nsColor, angle: angle, opacity: opacity)
                }
            }
        }
        dismiss()
    }
}

struct HeaderFooterSheet: View {
    @ObservedObject var editor: EditorModel
    let bates: Bool
    @Environment(\.dismiss) private var dismiss
    @State private var slots = ["", "", "", "", "", ""] // header L C R, footer L C R
    @State private var size = 10.0
    @State private var margin = 28.0
    @State private var prefix = "MK"
    @State private var start = 1
    @State private var digits = 6
    @State private var batesSlot = 5

    var body: some View {
        Form {
            Text(bates ? "Bates Numbering" : "Header & Footer").font(.title2.bold())
            if bates {
                TextField("Prefix", text: $prefix)
                Stepper("Start at \(start)", value: $start, in: 0...9_999_999)
                Stepper("Digits \(digits)", value: $digits, in: 1...10)
                Picker("Position", selection: $batesSlot) {
                    Text("Bottom right").tag(5)
                    Text("Bottom center").tag(4)
                    Text("Bottom left").tag(3)
                    Text("Top right").tag(2)
                }
                Text("Example: \(batesNumber(0))").foregroundStyle(.secondary)
            } else {
                Text("Use {page}, {pages}, {date} and {file}.").font(.caption).foregroundStyle(.secondary)
                Section("Header") {
                    TextField("Left", text: $slots[0])
                    TextField("Center", text: $slots[1])
                    TextField("Right", text: $slots[2])
                }
                Section("Footer") {
                    TextField("Left", text: $slots[3])
                    TextField("Center", text: $slots[4], prompt: Text("Page {page} of {pages}"))
                    TextField("Right", text: $slots[5])
                }
            }
            Slider(value: $size, in: 6...24, step: 1) { Text("Font size \(Int(size))") }
            Slider(value: $margin, in: 10...72, step: 1) { Text("Margin \(Int(margin)) pt") }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Apply") { apply() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(22)
        .frame(width: 440)
    }

    private func batesNumber(_ i: Int) -> String {
        prefix + String(format: "%0\(digits)d", start + i)
    }

    private func apply() {
        var templates = slots
        if bates {
            templates = ["", "", "", "", "", ""]
        } else if templates.allSatisfy(\.isEmpty) {
            templates[4] = "Page {page} of {pages}"
        }
        let font = NSFont.systemFont(ofSize: size)
        let count = editor.pageCount
        let file = editor.documentName
        let m = margin
        editor.transformPages(bates ? "Bates Numbering" : "Header & Footer") { page, index in
            PageCompositor.compose(page) { ctx in
                let s = page.displaySize
                func slotPoint(_ slot: Int) -> (CGPoint, CGPoint) {
                    let x: CGFloat = [m, s.width / 2, s.width - m][slot % 3]
                    let ax: CGFloat = [0, 0.5, 1][slot % 3]
                    return slot < 3 ? (CGPoint(x: x, y: s.height - m), CGPoint(x: ax, y: 1)) : (CGPoint(x: x, y: m), CGPoint(x: ax, y: 0))
                }
                if bates {
                    let (p, a) = slotPoint(batesSlot)
                    PageText.draw(batesNumber(index), in: ctx, page: page, at: p, anchor: a, font: font, color: .black)
                }
                for (slot, template) in templates.enumerated() where !template.isEmpty {
                    let (p, a) = slotPoint(slot)
                    PageText.draw(PageText.expand(template, page: index + 1, pages: count, file: file), in: ctx, page: page,
                                  at: p, anchor: a, font: font, color: .black)
                }
            }
        }
        dismiss()
    }
}

struct SplitSheet: View {
    @ObservedObject var editor: EditorModel
    @Environment(\.dismiss) private var dismiss
    @State private var mode = 0
    @State private var every = 1
    @State private var ranges = ""
    @State private var parts = 2
    @State private var megabytes = 5.0
    @State private var mergeRanges = false

    var body: some View {
        Form {
            Text("Split Document").font(.title2.bold())
            Picker("Split by", selection: $mode) {
                Text("Number of pages").tag(0)
                Text("Page ranges").tag(1)
                Text("Number of files").tag(2)
                Text("Top-level bookmarks").tag(3)
                Text("File size").tag(4)
            }
            switch mode {
            case 0: Stepper("Every \(every) page(s)", value: $every, in: 1...max(1, editor.pageCount))
            case 1:
                TextField("Ranges", text: $ranges, prompt: Text("1-3; 4-8; 9-"))
                Toggle("Merge all ranges into one PDF", isOn: $mergeRanges)
            case 4:
                Stepper("At most \(String(format: "%.1f", megabytes)) MB per file", value: $megabytes, in: 0.5...500, step: 0.5)
                Text("Pages are kept together; a single page larger than the limit gets its own file.").font(.caption).foregroundStyle(.secondary)
            case 2: Stepper("\(parts) files", value: $parts, in: 2...max(2, editor.pageCount))
            default: Text("One file per top-level bookmark.").foregroundStyle(.secondary)
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Split…") { split() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(22)
        .frame(width: 400)
    }

    private func groups() -> [[Int]]? {
        let n = editor.pageCount
        switch mode {
        case 0: return stride(from: 0, to: n, by: every).map { Array($0..<min($0 + every, n)) }
        case 1: return ranges.split(separator: ";").map { PageRanges.parse(String($0), pageCount: n) }.allSatisfy { $0 != nil }
                ? ranges.split(separator: ";").compactMap { PageRanges.parse(String($0), pageCount: n) } : nil
        case 2:
            let size = Int((Double(n) / Double(parts)).rounded(.up))
            return stride(from: 0, to: n, by: max(1, size)).map { Array($0..<min($0 + size, n)) }
        case 4:
            return sizeGroups(limit: Int(megabytes * 1_000_000))
        default:
            let starts = (0..<(editor.pdf.outlineRoot?.numberOfChildren ?? 0)).compactMap { i -> Int? in
                guard let page = editor.pdf.outlineRoot?.child(at: i)?.destination?.page else { return nil }
                return editor.pdf.index(for: page)
            }.sorted()
            guard !starts.isEmpty else { return nil }
            let bounds = (starts.first == 0 ? starts : [0] + starts) + [n]
            return zip(bounds, bounds.dropFirst()).filter { $0 < $1 }.map { Array($0..<$1) }
        }
    }

    /// Greedy grouping by each page's size on its own (shared fonts are counted per page, so files stay under the limit).
    private func sizeGroups(limit: Int) -> [[Int]]? {
        guard let copy = PDFExporter.copy(of: editor.pdf), let data = copy.dataRepresentation() else { return nil }
        let sizes: [Int] = (0..<copy.pageCount).map { i in
            guard let doc = PDFDocument(data: data) else { return 0 }
            for j in (0..<doc.pageCount).reversed() where j != i { doc.removePage(at: j) }
            return doc.dataRepresentation()?.count ?? 0
        }
        var groups: [[Int]] = []
        var current: [Int] = []
        var total = 0
        for (i, size) in sizes.enumerated() {
            if !current.isEmpty, total + size > limit {
                groups.append(current)
                current = []
                total = 0
            }
            current.append(i)
            total += size
        }
        if !current.isEmpty { groups.append(current) }
        return groups
    }

    private func split() {
        if mode == 1 && mergeRanges {
            guard let groups = groups(), let doc = editor.extractedDocument(groups.flatMap { $0 }) else { return Panels.alert("Check the page ranges") }
            DocumentLauncher.open(doc)
            return dismiss()
        }
        guard let groups = groups(), !groups.isEmpty else { return Panels.alert("Check the split settings") }
        guard let folder = Panels.folder(title: "Choose where to save the \(groups.count) files") else { return }
        for (i, pages) in groups.enumerated() {
            guard let doc = editor.extractedDocument(pages) else { continue }
            doc.write(to: folder.appendingPathComponent("\(editor.documentName) part \(i + 1).pdf"))
        }
        NSWorkspace.shared.activateFileViewerSelecting([folder])
        dismiss()
    }
}

struct PropertiesSheet: View {
    @ObservedObject var editor: EditorModel
    @ObservedObject var document: PDFFileDocument
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var author = ""
    @State private var subject = ""
    @State private var keywords = ""

    var body: some View {
        let pdf = document.pdf
        let attrs = pdf.documentAttributes ?? [:]
        Form {
            Text("Document Properties").font(.title2.bold())
            Section("Description") {
                TextField("Title", text: $title)
                TextField("Author", text: $author)
                TextField("Subject", text: $subject)
                TextField("Keywords", text: $keywords, prompt: Text("comma separated"))
            }
            Section("Details") {
                LabeledContent("File", value: editor.fileURL?.path ?? "Not saved")
                LabeledContent("Pages", value: "\(pdf.pageCount)")
                if let page = pdf.page(at: 0) {
                    let s = page.bounds(for: .cropBox).size
                    LabeledContent("Page size", value: String(format: "%.1f × %.1f in (%.0f × %.0f pt)", s.width / 72, s.height / 72, s.width, s.height))
                }
                LabeledContent("PDF version", value: "\(pdf.majorVersion).\(pdf.minorVersion)")
                LabeledContent("Creator", value: attrs[PDFDocumentAttribute.creatorAttribute] as? String ?? "—")
                LabeledContent("Producer", value: attrs[PDFDocumentAttribute.producerAttribute] as? String ?? "—")
                LabeledContent("Created", value: (attrs[PDFDocumentAttribute.creationDateAttribute] as? Date)?.formatted() ?? "—")
                LabeledContent("Modified", value: (attrs[PDFDocumentAttribute.modificationDateAttribute] as? Date)?.formatted() ?? "—")
                LabeledContent("Security", value: document.security == nil ? (pdf.isEncrypted ? "Encrypted" : "None") : "Password protected")
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Save") {
                    var updated = attrs
                    updated[PDFDocumentAttribute.titleAttribute] = title
                    updated[PDFDocumentAttribute.authorAttribute] = author
                    updated[PDFDocumentAttribute.subjectAttribute] = subject
                    updated[PDFDocumentAttribute.keywordsAttribute] = keywords.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
                    editor.setDocumentAttributes(updated)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(22)
        .frame(width: 480)
        .onAppear {
            title = attrs[PDFDocumentAttribute.titleAttribute] as? String ?? ""
            author = attrs[PDFDocumentAttribute.authorAttribute] as? String ?? ""
            subject = attrs[PDFDocumentAttribute.subjectAttribute] as? String ?? ""
            let kw = attrs[PDFDocumentAttribute.keywordsAttribute]
            keywords = (kw as? [String])?.joined(separator: ", ") ?? (kw as? String) ?? ""
        }
    }
}
