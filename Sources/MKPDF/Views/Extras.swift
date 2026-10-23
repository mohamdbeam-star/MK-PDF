import SwiftUI
import PDFKit
import Translation

// MARK: - Appearance

enum Appearance: String, CaseIterable, Identifiable {
    case system = "System", light = "Light", dark = "Dark"
    var id: String { rawValue }

    static var current: Appearance {
        Appearance(rawValue: UserDefaults.standard.string(forKey: "appearance") ?? "") ?? .system
    }

    static func apply(_ value: Appearance = current) {
        UserDefaults.standard.set(value.rawValue, forKey: "appearance")
        switch value {
        case .system: NSApp.appearance = nil
        case .light: NSApp.appearance = NSAppearance(named: .aqua)
        case .dark: NSApp.appearance = NSAppearance(named: .darkAqua)
        }
    }
}

// MARK: - Translate

/// Translates the document on-device and opens the result as a new PDF.
struct TranslatePanel: View {
    @ObservedObject var editor: EditorModel
    @State private var target = Locale.Language(identifier: "en")
    @State private var configuration: TranslationSession.Configuration?
    @State private var result = ""
    @State private var working = false
    @State private var error: String?

    private let languages = ["ar", "en", "fr", "de", "es", "it", "pt", "ru", "zh-Hans", "ja", "ko", "tr", "hi", "nl", "pl", "uk"]

    var body: some View {
        SectionTitle("Translate")
        Picker("Into", selection: $target) {
            ForEach(languages, id: \.self) { code in
                Text(Locale.current.localizedString(forIdentifier: code) ?? code).tag(Locale.Language(identifier: code))
            }
        }
        Button {
            error = nil
            result = ""
            working = true
            if configuration?.target == target { configuration?.invalidate() } else { configuration = .init(target: target) }
        } label: { Label("Translate Document", systemImage: "character.bubble") }
            .disabled(working)
        if working { ProgressView().controlSize(.small) }
        if let error { Text(error).font(.caption).foregroundStyle(.red) }
        if !result.isEmpty {
            Text(String(result.prefix(600)) + (result.count > 600 ? "…" : "")).font(.callout).textSelection(.enabled)
                .padding(8).background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
            HStack {
                Button("Open as PDF") {
                    if let doc = Creator.paginate(NSAttributedString(string: result, attributes: [.font: NSFont.systemFont(ofSize: 12)])) {
                        DocumentLauncher.open(doc)
                    }
                }
                Button("Copy") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(result, forType: .string)
                }
            }
        }
        EmptyView()
            .translationTask(configuration) { session in
                let pages = editor.pdf.pages.map { $0.string ?? "" }
                var out: [String] = []
                do {
                    for text in pages {
                        var translated: [String] = []
                        for paragraph in text.components(separatedBy: "\n") {
                            let p = paragraph.trimmingCharacters(in: .whitespaces)
                            translated.append(p.isEmpty ? "" : try await session.translate(p).targetText)
                        }
                        out.append(translated.joined(separator: "\n"))
                    }
                    result = out.joined(separator: "\n\u{0C}")
                } catch {
                    self.error = "Translation isn't available: \(error.localizedDescription)"
                }
                working = false
            }
    }
}

// MARK: - Scan with iPhone

/// Hosts the "Import from iPhone or iPad" menu (Continuity Camera) and turns the scan into a PDF.
final class ContinuityCameraView: NSView, NSServicesMenuRequestor {
    static weak var shared: ContinuityCameraView?

    override var acceptsFirstResponder: Bool { true }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil { Self.shared = self }
    }

    func showMenu() {
        guard let window else { return }
        window.makeFirstResponder(self)
        let menu = NSMenu()
        let item = NSMenuItem(title: "Import from iPhone or iPad", action: nil, keyEquivalent: "")
        item.identifier = NSMenuItem.importFromDeviceIdentifier
        menu.addItem(item)
        let point = window.mouseLocationOutsideOfEventStream
        menu.popUp(positioning: nil, at: convert(point, from: nil), in: self)
    }

    override func validRequestor(forSendType sendType: NSPasteboard.PasteboardType?, returnType: NSPasteboard.PasteboardType?) -> Any? {
        if let returnType, [.pdf, .png, .tiff, NSPasteboard.PasteboardType("public.jpeg")].contains(returnType) { return self }
        return super.validRequestor(forSendType: sendType, returnType: returnType)
    }

    func readSelection(from pasteboard: NSPasteboard) -> Bool {
        if let data = pasteboard.data(forType: .pdf), let doc = PDFDocument(data: data) {
            DocumentLauncher.open(doc)
            return true
        }
        if let image = NSImage(pasteboard: pasteboard), let page = PageFactory.page(for: image, paper: PageFactory.a4) {
            let doc = PDFDocument()
            doc.insert(page, at: 0)
            DocumentLauncher.open(doc)
            return true
        }
        return false
    }

    func writeSelection(to pboard: NSPasteboard, types: [NSPasteboard.PasteboardType]) -> Bool { false }
}

struct ContinuityCameraHost: NSViewRepresentable {
    func makeNSView(context: Context) -> ContinuityCameraView { ContinuityCameraView() }
    func updateNSView(_ nsView: ContinuityCameraView, context: Context) {}
}

// MARK: - Visual compare

/// Both pages drawn over each other: unchanged content is dark, the original's leftovers red, the revision's additions blue.
enum OverlayCompare {
    static func image(original: PDFPage?, revised: PDFPage?, dpi: CGFloat = 110) -> NSImage? {
        let a = original.flatMap { PageRenderer.image(of: $0, dpi: dpi) }
        let b = revised.flatMap { PageRenderer.image(of: $0, dpi: dpi) }
        guard a != nil || b != nil else { return nil }
        let w = max(a?.width ?? 0, b?.width ?? 0), h = max(a?.height ?? 0, b?.height ?? 0)
        func gray(_ img: CGImage?) -> [UInt8] {
            var px = [UInt8](repeating: 255, count: w * h)
            guard let img, let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                               space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return px }
            ctx.draw(img, in: CGRect(x: 0, y: h - img.height, width: img.width, height: img.height))
            return px
        }
        let ga = gray(a), gb = gray(b)
        var rgba = [UInt8](repeating: 255, count: w * h * 4)
        for i in 0..<(w * h) {
            let inkA = ga[i] < 200, inkB = gb[i] < 200
            let o = i * 4
            switch (inkA, inkB) {
            case (true, true): rgba[o] = 60; rgba[o + 1] = 60; rgba[o + 2] = 60
            case (true, false): rgba[o] = 230; rgba[o + 1] = 40; rgba[o + 2] = 40
            case (false, true): rgba[o] = 30; rgba[o + 1] = 110; rgba[o + 2] = 240
            default: break
            }
        }
        guard let provider = CGDataProvider(data: Data(rgba) as CFData),
              let out = CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: w * 4,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                                provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent) else { return nil }
        return NSImage(cgImage: out, size: NSSize(width: w, height: h))
    }
}
