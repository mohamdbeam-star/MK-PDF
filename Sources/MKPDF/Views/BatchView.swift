import SwiftUI
import PDFKit
import UniformTypeIdentifiers

/// Applies one tool to many files and writes the results to a folder.
struct BatchView: View {
    enum Operation: String, CaseIterable, Identifiable {
        case compress = "Compress"
        case ocr = "Recognize text (OCR)"
        case pageNumbers = "Add page numbers"
        case watermark = "Add text watermark"
        case protect = "Protect with password"
        case rotate = "Rotate all pages"
        case flatten = "Flatten forms & comments"
        case removeMetadata = "Remove metadata"
        case images = "Convert to JPG images"
        case word = "Convert to Word"
        case excel = "Convert to Excel"
        case text = "Convert to text"
        var id: String { rawValue }
    }

    @State private var files: [URL] = []
    @State private var operation = Operation.compress
    @State private var preset = Compressor.Preset.balanced
    @State private var text = "CONFIDENTIAL"
    @State private var password = ""
    @State private var degrees = 90
    @State private var running = false
    @State private var progress = 0.0
    @State private var log: [String] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Batch Process").font(.title2.bold())
            Text("Run one tool on many PDFs at once. Results are saved to a folder you choose; the originals are not changed.")
                .foregroundStyle(.secondary).font(.callout)
            List {
                ForEach(files, id: \.self) { url in
                    HStack {
                        Image(nsImage: NSWorkspace.shared.icon(forFile: url.path)).resizable().frame(width: 18, height: 18)
                        Text(url.lastPathComponent)
                    }
                }
                .onDelete { files.remove(atOffsets: $0) }
            }
            .frame(minHeight: 150)
            .overlay { if files.isEmpty { ContentUnavailableView("Drop PDFs here", systemImage: "tray.and.arrow.down") } }
            .onDrop(of: [.fileURL], isTargeted: nil) { providers in
                for p in providers {
                    _ = p.loadObject(ofClass: URL.self) { url, _ in
                        if let url, url.pathExtension.lowercased() == "pdf" { DispatchQueue.main.async { files.append(url) } }
                    }
                }
                return true
            }
            HStack {
                Button { files += Panels.open([.pdf], multiple: true) } label: { Label("Add PDFs…", systemImage: "plus") }
                Button("Clear") { files = [] }.disabled(files.isEmpty)
                Spacer()
                Text("\(files.count) files").foregroundStyle(.secondary)
            }
            Form {
                Picker("Tool", selection: $operation) { ForEach(Operation.allCases) { Text($0.rawValue).tag($0) } }
                switch operation {
                case .compress:
                    Picker("Level", selection: $preset) { ForEach(Compressor.Preset.allCases) { Text($0.title).tag($0) } }
                case .watermark:
                    TextField("Text", text: $text)
                case .protect:
                    SecureField("Password", text: $password)
                case .rotate:
                    Picker("Angle", selection: $degrees) {
                        Text("90° clockwise").tag(90)
                        Text("180°").tag(180)
                        Text("90° counterclockwise").tag(270)
                    }
                default:
                    EmptyView()
                }
            }
            if running { ProgressView(value: progress) }
            if !log.isEmpty {
                ScrollView { Text(log.joined(separator: "\n")).font(.caption.monospaced()).frame(maxWidth: .infinity, alignment: .leading) }
                    .frame(maxHeight: 90)
            }
            HStack {
                Spacer()
                Button("Process \(files.count) Files…") { start() }
                    .buttonStyle(.borderedProminent)
                    .disabled(files.isEmpty || running || (operation == .protect && password.isEmpty))
            }
        }
        .padding(20)
    }

    private func start() {
        guard let folder = Panels.folder(title: "Choose where to save the results") else { return }
        running = true
        progress = 0
        log = []
        Task { @MainActor in
            for (i, url) in files.enumerated() {
                do {
                    try await BatchJob(operation: operation, preset: preset, text: text, password: password, degrees: degrees)
                        .process(url, into: folder)
                    log.append("✓ \(url.lastPathComponent)")
                } catch {
                    log.append("✗ \(url.lastPathComponent): \(error.localizedDescription)")
                }
                progress = Double(i + 1) / Double(files.count)
            }
            running = false
            let ok = log.filter { $0.hasPrefix("✓") }.count
            Notifier.taskFinished("Batch finished", detail: "\(operation.rawValue): \(ok) of \(files.count) files")
            NSWorkspace.shared.activateFileViewerSelecting([folder])
        }
    }

}

/// One batch tool with its settings, applied to a file at a time.
struct BatchJob {
    var operation: BatchView.Operation
    var preset = Compressor.Preset.balanced
    var text = "CONFIDENTIAL"
    var password = ""
    var degrees = 90

    struct BatchError: LocalizedError {
        let errorDescription: String?
    }

    @MainActor
    func process(_ url: URL, into folder: URL) async throws {
        guard let pdf = PDFDocument(url: url) else { throw BatchError(errorDescription: "Not a readable PDF") }
        if pdf.isLocked { throw BatchError(errorDescription: "Password protected") }
        // Reuse the editor's own tools on a headless document.
        let document = PDFFileDocument()
        document.pdf = pdf
        let editor = EditorModel(document: document)
        let base = folder.appendingPathComponent(url.deletingPathExtension().lastPathComponent)
        func savePDF(_ suffix: String) throws {
            try PDFExporter.data(for: document.pdf, security: document.security).write(to: URL(fileURLWithPath: base.path + " \(suffix).pdf"))
        }
        switch operation {
        case .compress:
            let data = try await background { try Compressor.compressedData(pdf, preset: preset) }
            try data.write(to: URL(fileURLWithPath: base.path + " compressed.pdf"))
        case .ocr:
            let lines = try await background { try pdf.pages.map { page -> [OCR.Line] in
                (page.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? try OCR.recognize(page, language: nil, accurate: true) : []
            } }
            editor.transformPages("OCR") { page, i in
                lines[i].isEmpty ? nil : PageCompositor.compose(page) { OCR.drawInvisibleText(lines[i], in: $0) }
            }
            try savePDF("searchable")
        case .pageNumbers:
            let count = pdf.pageCount
            editor.transformPages("Page Numbers") { page, i in
                PageCompositor.compose(page) { ctx in
                    PageText.draw("Page \(i + 1) of \(count)", in: ctx, page: page, at: CGPoint(x: page.displaySize.width / 2, y: 28),
                                  anchor: CGPoint(x: 0.5, y: 0), font: .systemFont(ofSize: 10), color: .black)
                }
            }
            try savePDF("numbered")
        case .watermark:
            editor.transformPages("Watermark") { page, _ in
                PageCompositor.compose(page) { ctx in
                    let s = page.displaySize
                    PageText.draw(text, in: ctx, page: page, at: CGPoint(x: s.width / 2, y: s.height / 2), anchor: CGPoint(x: 0.5, y: 0.5),
                                  font: .systemFont(ofSize: 72, weight: .bold), color: .systemRed, angle: 45, opacity: 0.18)
                }
            }
            try savePDF("watermarked")
        case .protect:
            document.security = SecuritySettings(userPassword: password, ownerPassword: password, permissions: SecuritySettings.allPermissions)
            try savePDF("protected")
        case .rotate:
            editor.rotate(pdf.pages, by: degrees)
            try savePDF("rotated")
        case .flatten:
            editor.flattenAnnotations(includeForms: true)
            try savePDF("flattened")
        case .removeMetadata:
            document.pdf.documentAttributes = [:]
            try savePDF("clean")
        case .images:
            let pages = pdf.pages
            try await background {
                for (i, page) in pages.enumerated() {
                    if let img = PageRenderer.image(of: page, dpi: 150)?.rotated(by: page.normalizedRotation), let jpg = PageRenderer.jpegData(img, quality: 0.9) {
                        try jpg.write(to: URL(fileURLWithPath: base.path + " \(i + 1).jpg"))
                    }
                }
            }
        case .word:
            let text = editor.attributedText()
            try text.data(from: NSRange(location: 0, length: text.length), documentAttributes: [.documentType: NSAttributedString.DocumentType.officeOpenXML])
                .write(to: base.appendingPathExtension("docx"))
        case .excel:
            let data = await background { OfficeExport.xlsx(pdf) }
            try data.write(to: base.appendingPathExtension("xlsx"))
        case .text:
            try pdf.pages.map { $0.string ?? "" }.joined(separator: "\n\n\u{0C}").write(to: base.appendingPathExtension("txt"), atomically: true, encoding: .utf8)
        }
    }

    private func background<T>(_ work: @escaping () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { c in
            DispatchQueue.global(qos: .userInitiated).async { c.resume(with: Result { try work() }) }
        }
    }

    private func background<T>(_ work: @escaping () -> T) async -> T {
        await withCheckedContinuation { c in DispatchQueue.global(qos: .userInitiated).async { c.resume(returning: work()) } }
    }
}
