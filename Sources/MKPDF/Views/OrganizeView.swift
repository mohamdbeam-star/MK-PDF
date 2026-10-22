import SwiftUI
import PDFKit
import UniformTypeIdentifiers

/// Full-window page grid: select, drag to reorder, rotate, insert, extract, delete.
struct OrganizeView: View {
    @ObservedObject var editor: EditorModel
    @ObservedObject var document: PDFFileDocument
    @State private var selection: Set<Int> = []
    @State private var thumbWidth: CGFloat = 150
    @State private var dragging: Int?

    var body: some View {
        let pages = document.pdf.pages
        VStack(spacing: 0) {
            HStack(spacing: 14) {
                Button { editor.rotate(selectedPages, by: -90) } label: { Label("Rotate Left", systemImage: "rotate.left") }
                Button { editor.rotate(selectedPages, by: 90) } label: { Label("Rotate Right", systemImage: "rotate.right") }
                Button(role: .destructive) { deleteSelection() } label: { Label("Delete", systemImage: "trash") }
                Divider().frame(height: 18)
                Button { editor.insertBlankPage(after: selection.max() ?? document.pdf.pageCount - 1) } label: { Label("Insert Blank", systemImage: "doc.badge.plus") }
                Button { editor.insertFromFile(after: selection.max() ?? document.pdf.pageCount - 1) } label: { Label("Insert File", systemImage: "doc.on.doc") }
                Button { editor.duplicatePages(sortedSelection) } label: { Label("Duplicate", systemImage: "plus.square.on.square") }
                Button { if let doc = editor.extractedDocument(sortedSelection) { DocumentLauncher.open(doc) } } label: { Label("Extract", systemImage: "square.and.arrow.up.on.square") }
                Button { editor.sheet = .split } label: { Label("Split", systemImage: "scissors") }
                Button { reverse() } label: { Label("Reverse", systemImage: "arrow.up.arrow.down") }
                Spacer()
                Text(selection.isEmpty ? "\(pages.count) pages" : "\(selection.count) of \(pages.count) selected")
                    .foregroundStyle(.secondary).font(.callout)
                Slider(value: $thumbWidth, in: 90...300).frame(width: 110).help("Thumbnail size")
                Button("Done") { editor.organizing = false }.keyboardShortcut(.cancelAction)
            }
            .labelStyle(.iconOnly)
            .buttonStyle(.borderless)
            .disabled(editor.busy != nil)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            Divider()
            ScrollView {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: thumbWidth + 20), spacing: 18)], spacing: 22) {
                    ForEach(Array(pages.enumerated()), id: \.element) { index, page in
                        VStack(spacing: 6) {
                            PageThumbnail(page: page, width: thumbWidth, revision: document.revision)
                                .padding(4)
                                .overlay(RoundedRectangle(cornerRadius: 4).stroke(selection.contains(index) ? Color.accentColor : .clear, lineWidth: 3))
                                .opacity(dragging == index ? 0.4 : 1)
                            Text("\(index + 1)").font(.caption).foregroundStyle(.secondary)
                        }
                        .contentShape(Rectangle())
                        .onTapGesture(count: 2) {
                            editor.organizing = false
                            DispatchQueue.main.async { editor.go(to: index) }
                        }
                        .onTapGesture { toggle(index) }
                        .onDrag {
                            dragging = index
                            if !selection.contains(index) { selection = [index] }
                            return NSItemProvider(object: "\(index)" as NSString)
                        }
                        .onDrop(of: [.text], delegate: PageDropDelegate(target: index, editor: editor, selection: $selection, dragging: $dragging))
                        .contextMenu { PageContextMenu(editor: editor, indices: selection.contains(index) ? sortedSelection : [index]) }
                    }
                }
                .padding(20)
            }
            .background(Color(nsColor: .underPageBackgroundColor))
        }
        .onChange(of: document.pdf.pageCount) { _, count in selection = selection.filter { $0 < count } }
    }

    private var sortedSelection: [Int] { selection.isEmpty ? [editor.pageIndex] : selection.sorted() }
    private var selectedPages: [PDFPage] { sortedSelection.compactMap { editor.pdf.page(at: $0) } }

    private func toggle(_ index: Int) {
        let flags = NSEvent.modifierFlags
        if flags.contains(.command) {
            if selection.contains(index) { selection.remove(index) } else { selection.insert(index) }
        } else if flags.contains(.shift), let anchor = selection.min() {
            selection = Set(min(anchor, index)...max(anchor, index))
        } else {
            selection = [index]
        }
    }

    private func deleteSelection() {
        editor.deletePages(sortedSelection)
        selection = []
    }

    private func reverse() {
        editor.setPageOrder(editor.pdf.pages.reversed(), name: "Reverse Pages")
    }
}

private struct PageDropDelegate: DropDelegate {
    let target: Int
    let editor: EditorModel
    @Binding var selection: Set<Int>
    @Binding var dragging: Int?

    func dropUpdated(info: DropInfo) -> DropProposal? { DropProposal(operation: .move) }

    func performDrop(info: DropInfo) -> Bool {
        defer { dragging = nil }
        guard let source = dragging else { return false }
        let moving = selection.contains(source) ? IndexSet(selection) : IndexSet(integer: source)
        guard !moving.contains(target) else { return false }
        let destination = target > (moving.max() ?? 0) ? target + 1 : target
        editor.movePages(moving, to: destination)
        // Re-select the moved pages at their new positions.
        let before = moving.filter { $0 < destination }.count
        let start = destination - before
        selection = Set(start..<(start + moving.count))
        return true
    }
}
