import SwiftUI
import PDFKit

struct CompareRequest: Codable, Hashable {
    let original: URL
    let revised: URL
}

/// Side-by-side comparison with a word-level change list.
struct CompareView: View {
    let request: CompareRequest
    @State private var left: PDFDocument?
    @State private var right: PDFDocument?
    @State private var changes: [Change] = []
    @State private var selected: Change.ID?

    struct Change: Identifiable {
        let id = UUID()
        let page: Int
        let removed: String
        let added: String
    }

    var body: some View {
        HSplitView {
            List(changes, selection: $selected) { change in
                VStack(alignment: .leading, spacing: 3) {
                    Text("Page \(change.page + 1)").font(.caption.bold())
                    if !change.removed.isEmpty { Text(change.removed).strikethrough().foregroundStyle(.red).lineLimit(3) }
                    if !change.added.isEmpty { Text(change.added).foregroundStyle(.green).lineLimit(3) }
                }
            }
            .frame(minWidth: 220, idealWidth: 260, maxWidth: 360)
            .overlay {
                if changes.isEmpty && left != nil { ContentUnavailableView("No text differences", systemImage: "checkmark.circle") }
            }
            VStack(spacing: 0) {
                header(request.original, "Original")
                ComparePane(document: left, highlight: selectedChange.map { ($0.page, $0.removed) })
            }
            VStack(spacing: 0) {
                header(request.revised, "Revised")
                ComparePane(document: right, highlight: selectedChange.map { ($0.page, $0.added) })
            }
        }
        .navigationTitle("Compare: \(request.original.lastPathComponent) ↔ \(request.revised.lastPathComponent)")
        .task { load() }
    }

    private var selectedChange: Change? { changes.first { $0.id == selected } }

    private func header(_ url: URL, _ label: String) -> some View {
        HStack {
            Text(label).bold()
            Text(url.lastPathComponent).foregroundStyle(.secondary).lineLimit(1)
            Spacer()
        }
        .padding(8)
        .background(.bar)
    }

    private func load() {
        left = PDFDocument(url: request.original)
        right = PDFDocument(url: request.revised)
        guard let left, let right else { return }
        changes = Self.diff(left, right)
    }

    static func diff(_ a: PDFDocument, _ b: PDFDocument) -> [Change] {
        var result: [Change] = []
        for i in 0..<max(a.pageCount, b.pageCount) {
            let wa = words(a.page(at: i)), wb = words(b.page(at: i))
            let diff = wb.difference(from: wa)
            var removed: [Int: String] = [:], inserted: [Int: String] = [:]
            for c in diff {
                switch c {
                case let .remove(offset, w, _): removed[offset] = w
                case let .insert(offset, w, _): inserted[offset] = w
                }
            }
            // Group consecutive offsets into phrases.
            func phrases(_ dict: [Int: String]) -> [(Int, String)] {
                var out: [(Int, String)] = []
                for k in dict.keys.sorted() {
                    if let last = out.last, k == last.0 + last.1.split(separator: " ").count {
                        out[out.count - 1].1 += " " + dict[k]!
                    } else {
                        out.append((k, dict[k]!))
                    }
                }
                return out
            }
            let r = phrases(removed), n = phrases(inserted)
            for j in 0..<max(r.count, n.count) {
                result.append(Change(page: i, removed: j < r.count ? r[j].1 : "", added: j < n.count ? n[j].1 : ""))
            }
        }
        return result
    }

    private static func words(_ page: PDFPage?) -> [String] {
        (page?.string ?? "").split(whereSeparator: { $0.isWhitespace }).map(String.init)
    }
}

struct ComparePane: NSViewRepresentable {
    let document: PDFDocument?
    let highlight: (Int, String)?

    func makeNSView(context: Context) -> PDFView {
        let v = PDFView()
        v.autoScales = true
        v.displayMode = .singlePageContinuous
        return v
    }

    func updateNSView(_ v: PDFView, context: Context) {
        if v.document !== document { v.document = document }
        guard let (page, text) = highlight, !text.isEmpty, let doc = document, let p = doc.page(at: page) else {
            v.highlightedSelections = nil
            return
        }
        let first = String(text.split(separator: " ").prefix(6).joined(separator: " "))
        let matches = doc.findString(first, withOptions: []).filter { $0.pages.contains(p) }
        for m in matches { m.color = .systemOrange }
        v.highlightedSelections = matches
        if let m = matches.first { v.go(to: m) } else { v.go(to: p) }
    }
}
