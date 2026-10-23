import SwiftUI
import PDFKit

enum ThumbnailCache {
    private static let cache = NSCache<NSString, NSImage>()

    static func image(_ page: PDFPage, width: CGFloat, revision: Int) -> NSImage {
        let key = "\(ObjectIdentifier(page).hashValue)-\(page.rotation)-\(Int(width))-\(revision)" as NSString
        if let hit = cache.object(forKey: key) { return hit }
        let size = page.displaySize
        let height = size.width > 0 ? width * size.height / size.width : width
        let image = page.thumbnail(of: CGSize(width: width * 2, height: height * 2), for: .cropBox)
        cache.setObject(image, forKey: key)
        return image
    }
}

struct PageThumbnail: View {
    let page: PDFPage
    let width: CGFloat
    let revision: Int

    var body: some View {
        Image(nsImage: ThumbnailCache.image(page, width: width, revision: revision))
            .resizable()
            .aspectRatio(contentMode: .fit)
            .frame(width: width)
            .background(Color.white)
            .shadow(color: .black.opacity(0.25), radius: 2, y: 1)
    }
}

struct SidebarView: View {
    @ObservedObject var editor: EditorModel
    @ObservedObject var document: PDFFileDocument

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $editor.sidebar) {
                ForEach(SidebarMode.allCases) { mode in
                    Image(systemName: mode.symbol).help(mode.title).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(8)
            Divider()
            switch editor.sidebar {
            case .thumbnails: ThumbnailSidebar(editor: editor, document: document)
            case .bookmarks: BookmarkSidebar(editor: editor, document: document)
            case .comments: CommentsSidebar(editor: editor, document: document)
            case .search: SearchSidebar(editor: editor, document: document)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}

struct ThumbnailSidebar: View {
    @ObservedObject var editor: EditorModel
    @ObservedObject var document: PDFFileDocument

    var body: some View {
        let pages = document.pdf.pages
        ScrollViewReader { proxy in
            List {
                ForEach(Array(pages.enumerated()), id: \.element) { index, page in
                    VStack(spacing: 4) {
                        PageThumbnail(page: page, width: 120, revision: document.revision)
                            .overlay(RoundedRectangle(cornerRadius: 2)
                                .stroke(index == editor.pageIndex ? Color.accentColor : .clear, lineWidth: 3))
                        Text(page.label ?? "\(index + 1)").font(.caption).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 4)
                    .contentShape(Rectangle())
                    .onTapGesture { editor.go(to: index) }
                    .id(index)
                    .contextMenu { PageContextMenu(editor: editor, indices: [index]) }
                }
                .onMove { editor.movePages($0, to: $1) }
            }
            .listStyle(.sidebar)
            .onChange(of: editor.pageIndex) { _, i in withAnimation { proxy.scrollTo(i) } }
        }
    }
}

struct PageContextMenu: View {
    @ObservedObject var editor: EditorModel
    let indices: [Int]

    private var pages: [PDFPage] { indices.compactMap { editor.pdf.page(at: $0) } }

    var body: some View {
        Button("Rotate Clockwise") { editor.rotate(pages, by: 90) }
        Button("Rotate Counterclockwise") { editor.rotate(pages, by: -90) }
        Divider()
        Button("Insert Blank Page After") { editor.insertBlankPage(after: indices.max() ?? 0) }
        Button("Insert from File…") { editor.insertFromFile(after: indices.max() ?? 0) }
        Button("Duplicate") { editor.duplicatePages(indices) }
        if indices.count == 1 { Button("Replace…") { editor.replacePage(indices[0]) } }
        Button("Extract to New PDF") { if let doc = editor.extractedDocument(indices) { DocumentLauncher.open(doc) } }
        Divider()
        Button("Delete", role: .destructive) { editor.deletePages(indices) }
    }
}

struct OutlineNode: Identifiable {
    let id: ObjectIdentifier
    let outline: PDFOutline
    let children: [OutlineNode]?

    init(_ outline: PDFOutline) {
        id = ObjectIdentifier(outline)
        self.outline = outline
        let kids = (0..<outline.numberOfChildren).compactMap { outline.child(at: $0) }.map(OutlineNode.init)
        children = kids.isEmpty ? nil : kids
    }
}

struct BookmarkSidebar: View {
    @ObservedObject var editor: EditorModel
    @ObservedObject var document: PDFFileDocument

    var body: some View {
        let _ = document.revision
        let nodes = document.pdf.outlineRoot.map { OutlineNode($0).children ?? [] } ?? []
        VStack(spacing: 0) {
            if nodes.isEmpty {
                ContentUnavailableView("No Bookmarks", systemImage: "bookmark", description: Text("Add a bookmark for the current page."))
                    .frame(maxHeight: .infinity)
            } else {
                List(nodes, children: \.children) { node in
                    Text(node.outline.label ?? "Untitled")
                        .lineLimit(2)
                        .contentShape(Rectangle())
                        .onTapGesture {
                            if let dest = node.outline.destination { editor.pdfView?.go(to: dest) }
                        }
                        .contextMenu {
                            Button("Rename…") { editor.renameBookmark(node.outline) }
                            Button("Delete", role: .destructive) { editor.deleteBookmark(node.outline) }
                        }
                }
                .listStyle(.sidebar)
            }
            Divider()
            Button { editor.addBookmark() } label: { Label("Add Bookmark", systemImage: "bookmark.fill") }
                .buttonStyle(.borderless)
                .padding(8)
        }
    }
}

extension EditorModel {
    func addBookmark() {
        guard let page = currentPage,
              let label = Panels.prompt("New Bookmark", value: "Page \(pdf.index(for: page) + 1)"), !label.isEmpty else { return }
        let root = pdf.outlineRoot ?? {
            let r = PDFOutline()
            pdf.outlineRoot = r
            return r
        }()
        let item = PDFOutline()
        item.label = label
        item.destination = PDFDestination(page: page, at: CGPoint(x: 0, y: page.bounds(for: .cropBox).maxY))
        insertBookmark(item, into: root, at: root.numberOfChildren)
    }

    func insertBookmark(_ item: PDFOutline, into parent: PDFOutline, at index: Int) {
        parent.insertChild(item, at: min(index, parent.numberOfChildren))
        changed()
        undoManager?.registerUndo(withTarget: self) { $0.deleteBookmark(item) }
        undoManager?.setActionName("Bookmark")
    }

    func deleteBookmark(_ item: PDFOutline) {
        guard let parent = item.parent else { return }
        let index = item.index
        item.removeFromParent()
        changed()
        undoManager?.registerUndo(withTarget: self) { $0.insertBookmark(item, into: parent, at: index) }
        undoManager?.setActionName("Bookmark")
    }

    func renameBookmark(_ item: PDFOutline) {
        guard let name = Panels.prompt("Rename Bookmark", value: item.label ?? ""), !name.isEmpty else { return }
        let old = item.label
        item.label = name
        changed()
        undoManager?.registerUndo(withTarget: self) { model in
            item.label = old
            model.changed()
        }
    }
}

struct CommentsSidebar: View {
    @ObservedObject var editor: EditorModel
    @ObservedObject var document: PDFFileDocument
    @State private var filter = ""

    var body: some View {
        let _ = document.revision
        let comments = editor.allComments.filter {
            filter.isEmpty || ($0.contents ?? "").localizedCaseInsensitiveContains(filter) || $0.displayName.localizedCaseInsensitiveContains(filter)
        }
        VStack(spacing: 0) {
            TextField("Filter comments", text: $filter).textFieldStyle(.roundedBorder).padding(8)
            if comments.isEmpty {
                ContentUnavailableView("No Comments", systemImage: "text.bubble", description: Text("Highlights, notes and drawings appear here."))
                    .frame(maxHeight: .infinity)
            } else {
                List(comments, id: \.self) { a in
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: a.symbolName).foregroundStyle(Color(nsColor: a.color.withAlphaComponent(1)))
                            .frame(width: 18)
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(a.displayName).font(.callout.bold())
                                Spacer()
                                Text("p. \(a.page.map { editor.pdf.index(for: $0) + 1 } ?? 0)").font(.caption).foregroundStyle(.secondary)
                            }
                            if let text = a.contents.flatMap({ $0.isEmpty ? nil : $0 }) ?? markedText(a) {
                                Text(text).font(.caption).lineLimit(3)
                            }
                            Text([a.userName, a.modificationDate?.formatted(date: .abbreviated, time: .shortened)].compactMap { $0 }.joined(separator: " · "))
                                .font(.caption2).foregroundStyle(.tertiary)
                        }
                    }
                    .padding(.vertical, 2)
                    .contentShape(Rectangle())
                    .onTapGesture { editor.reveal(a) }
                    .listRowBackground(editor.selectedAnnotation === a ? Color.accentColor.opacity(0.15) : nil)
                    .contextMenu { Button("Delete", role: .destructive) { editor.remove(a) } }
                }
                .listStyle(.sidebar)
            }
        }
    }
}

/// The page text under a highlight, underline or strikethrough.
private func markedText(_ a: PDFAnnotation) -> String? {
    guard ["Highlight", "Underline", "StrikeOut"].contains(a.type ?? ""), let page = a.page else { return nil }
    let s = page.selection(for: a.bounds.insetBy(dx: 0, dy: a.bounds.height * 0.2))?.string?.trimmingCharacters(in: .whitespacesAndNewlines)
    return s?.isEmpty == false ? s : nil
}

struct SearchSidebar: View {
    @ObservedObject var editor: EditorModel
    @ObservedObject var document: PDFFileDocument

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                TextField("Search", text: $editor.searchText).textFieldStyle(.roundedBorder)
                    .onSubmit { editor.runSearch() }
                    .onChange(of: editor.searchText) { _, text in
                        // Search as you type once there's enough to match.
                        if text.count >= 2 || text.isEmpty { editor.runSearch() }
                    }
                Toggle("Aa", isOn: $editor.searchCaseSensitive).toggleStyle(.button).help("Match case")
            }
            .padding(8)
            if editor.searchResults.isEmpty {
                ContentUnavailableView(editor.searchText.isEmpty ? "Search" : "No Results", systemImage: "magnifyingglass")
                    .frame(maxHeight: .infinity)
            } else {
                Text("\(editor.searchResults.count) results").font(.caption).foregroundStyle(.secondary)
                List(Array(editor.searchResults.enumerated()), id: \.offset) { _, result in
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Page \(result.pages.first.map { editor.pdf.index(for: $0) + 1 } ?? 0)").font(.caption.bold())
                        Text(Self.context(result)).font(.caption).lineLimit(2)
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { editor.go(to: result) }
                }
                .listStyle(.sidebar)
            }
        }
    }

    static func context(_ selection: PDFSelection) -> String {
        guard let copy = selection.copy() as? PDFSelection else { return selection.string ?? "" }
        copy.extend(atStart: 25)
        copy.extend(atEnd: 40)
        return (copy.string ?? "").replacingOccurrences(of: "\n", with: " ")
    }
}
