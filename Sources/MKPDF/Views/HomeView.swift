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
        HStack(alignment: .top, spacing: 0) {
            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 12) {
                    AppMark().frame(width: 44, height: 44)
                    VStack(alignment: .leading) {
                        Text("MK PDF").font(.largeTitle.bold())
                        Text("View, edit, sign and convert PDFs").foregroundStyle(.secondary)
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
                            .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(26)
            Divider()
            VStack(alignment: .leading, spacing: 8) {
                Text("Recent").font(.headline)
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
        .frame(width: 830, height: 470)
        .onAppear { recents = NSDocumentController.shared.recentDocumentURLs }
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
        RoundedRectangle(cornerRadius: 10)
            .fill(LinearGradient(colors: [Color(red: 0.86, green: 0.12, blue: 0.2), Color(red: 0.55, green: 0.05, blue: 0.35)], startPoint: .topLeading, endPoint: .bottomTrailing))
            .overlay(Text("MK").font(.system(size: 16, weight: .heavy)).foregroundStyle(.white))
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
        }
        .padding(20)
        .frame(width: 420)
    }
}
