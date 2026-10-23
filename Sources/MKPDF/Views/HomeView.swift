import SwiftUI
import PDFKit
import UniformTypeIdentifiers

struct HomeView: View {
    @Environment(\.openWindow) private var openWindow
    @State private var recents: [URL] = []

    private struct Tile: Identifiable {
        let id = UUID()
        let title: String
        let detail: String
        let symbol: String
        let color: Color
        let action: () -> Void
    }

    var body: some View {
        VStack(spacing: 0) {
        UpdateBanner()
        HStack(alignment: .top, spacing: 0) {
            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 12) {
                    AppMark().frame(width: 44, height: 44)
                    VStack(alignment: .leading) {
                        Text("MK PDF").font(.largeTitle.bold())
                        Text("View, edit, sign and convert PDFs").foregroundStyle(.secondary).fixedSize()
                    }
                }
                LazyVGrid(columns: Array(repeating: GridItem(.fixed(150), spacing: 12), count: 3), spacing: 12) {
                    ForEach(tiles) { tile in
                        Button(action: tile.action) {
                            VStack(alignment: .leading, spacing: 6) {
                                Image(systemName: tile.symbol).font(.title2).foregroundStyle(tile.color)
                                Text(tile.title).font(.headline).foregroundStyle(.primary)
                                Text(tile.detail).font(.caption).foregroundStyle(.secondary).lineLimit(2, reservesSpace: true)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                            .glassSurface(16, interactive: true)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .glassGroup(spacing: 12)
            }
            .padding(26)
            Divider()
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Recent").font(.headline)
                    Spacer()
                    if !recents.isEmpty {
                        Button("Clear") {
                            NSDocumentController.shared.clearRecentDocuments(nil)
                            recents = []
                        }
                        .buttonStyle(.link)
                    }
                }
                if recents.isEmpty {
                    Text("Files you open appear here.").font(.callout).foregroundStyle(.secondary)
                }
                ScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(recents, id: \.self) { url in
                            Button { DocumentLauncher.open(url: url) } label: {
                                HStack {
                                    Image(nsImage: NSWorkspace.shared.icon(forFile: url.path)).resizable().frame(width: 24, height: 24)
                                    VStack(alignment: .leading) {
                                        Text(url.lastPathComponent).lineLimit(1)
                                        Text(url.deletingLastPathComponent().path).font(.caption2).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                                    }
                                    Spacer()
                                }
                                .padding(6)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .padding(20)
            .frame(width: 280)
        }
        }
        .frame(width: 830, height: 610, alignment: .top)
        .background(BrandBackdrop())
        .background(ContinuityCameraHost().frame(width: 1, height: 1))
        .background(NoTabbingHost())
        .onAppear { recents = NSDocumentController.shared.recentDocumentURLs }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { _ in
            recents = NSDocumentController.shared.recentDocumentURLs
        }
    }

    private var tiles: [Tile] {
        [
            Tile(title: "Open", detail: "Open a PDF to view and edit", symbol: "folder", color: .blue) { NSDocumentController.shared.openDocument(nil) },
            Tile(title: "Create Blank", detail: "Start a new empty PDF", symbol: "doc.badge.plus", color: .indigo) { Creator.blank() },
            Tile(title: "Combine Files", detail: "Merge PDFs and images", symbol: "rectangle.stack.badge.plus", color: .purple) { openWindow(id: "combine") },
            Tile(title: "Images to PDF", detail: "Photos and scans to one PDF", symbol: "photo.on.rectangle", color: .orange) { Creator.fromImages() },
            Tile(title: "Document to PDF", detail: "Word, RTF, text or HTML", symbol: "doc.richtext", color: .teal) { Creator.fromDocument() },
            Tile(title: "Web Page to PDF", detail: "Capture a page from a URL", symbol: "globe", color: .green) { Creator.fromWebPage() },
            Tile(title: "Compare Files", detail: "Find differences between two PDFs", symbol: "doc.on.doc", color: .pink) { compare() },
            Tile(title: "From Clipboard", detail: "Paste an image, PDF or text", symbol: "doc.on.clipboard", color: .brown) { Creator.fromClipboard() },
            Tile(title: "Fill & Sign", detail: "Open a form to fill and sign", symbol: "signature", color: .red) { NSDocumentController.shared.openDocument(nil) },
            Tile(title: "Batch Process", detail: "Compress, OCR or convert many files", symbol: "square.stack.3d.forward.dottedline", color: .cyan) { openWindow(id: "batch") },
            Tile(title: "Scan with iPhone", detail: "Scan paper with your iPhone camera", symbol: "iphone.gen3.radiowaves.left.and.right", color: .mint) { ContinuityCameraView.shared?.showMenu() },
            Tile(title: "Repair PDF", detail: "Recover a damaged file", symbol: "bandage", color: .gray) {
                if let url = Panels.open([.pdf], title: "Choose a damaged PDF").first { DocumentLauncher.open(url: url) }
            },
        ]
    }

    private func compare() {
        guard let first = Panels.open([.pdf], title: "Choose the original PDF").first,
              let second = Panels.open([.pdf], title: "Choose the revised PDF").first else { return }
        openWindow(id: "compare", value: CompareRequest(original: first, revised: second))
    }
}

struct AppMark: View {
    var body: some View {
        Image(nsImage: NSApp.applicationIconImage).resizable().aspectRatio(contentMode: .fit)
    }
}

struct CombineView: View {
    @State private var files: [URL] = []
    @State private var selection: Set<URL> = []
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Combine Files").font(.title2.bold())
            Text("Add PDFs, images or documents. Drag to set the order.").foregroundStyle(.secondary)
            List(selection: $selection) {
                ForEach(files, id: \.self) { url in
                    HStack {
                        Image(nsImage: NSWorkspace.shared.icon(forFile: url.path)).resizable().frame(width: 22, height: 22)
                        Text(url.lastPathComponent)
                        Spacer()
                        if let doc = PDFDocument(url: url) { Text("\(doc.pageCount) pages").foregroundStyle(.secondary).font(.caption) }
                    }
                }
                .onMove { files.move(fromOffsets: $0, toOffset: $1) }
            }
            .onDrop(of: [.fileURL], isTargeted: nil) { providers in
                for p in providers {
                    _ = p.loadObject(ofClass: URL.self) { url, _ in
                        if let url { DispatchQueue.main.async { files.append(url) } }
                    }
                }
                return true
            }
            .overlay {
                if files.isEmpty { ContentUnavailableView("Drop files here", systemImage: "tray.and.arrow.down") }
            }
            HStack {
                Button { files += Panels.open([.pdf] + Panels.imageTypes + Panels.documentTypes, multiple: true) } label: { Label("Add Files…", systemImage: "plus") }
                Button { files.removeAll { selection.contains($0) } } label: { Label("Remove", systemImage: "minus") }.disabled(selection.isEmpty)
                Spacer()
                Button("Combine") {
                    guard let doc = Combiner.combine(files) else { return Panels.alert("Nothing to combine") }
                    DocumentLauncher.open(doc)
                    files = []
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(files.count < 1)
            }
        }
        .padding(20)
        .background(NoTabbingHost())
    }
}

struct SettingsView: View {
    @AppStorage("authorName") private var authorName = ""
    @AppStorage("dynamicStamps") private var dynamicStamps = true

    var body: some View {
        Form {
            TextField("Author name for comments", text: $authorName, prompt: Text(NSFullUserName()))
            Toggle("Add name and date to stamps", isOn: $dynamicStamps)
            LabeledContent("Saved signatures", value: "\(SignatureStore.shared.items.count)")
            Picker("Appearance", selection: Binding(get: { Appearance.current }, set: { Appearance.apply($0) })) {
                ForEach(Appearance.allCases) { Text($0.rawValue).tag($0) }
            }
            Toggle("Check for updates automatically", isOn: Binding(get: { UpdateChecker.shared.automatic },
                                                                   set: { UpdateChecker.shared.automatic = $0 }))
            LabeledContent("Version", value: UpdateChecker.currentVersion)
            Button("Check for Updates Now") { UpdateChecker.shared.check(userInitiated: true) }
        }
        .padding(20)
        .frame(width: 420)
    }
}
