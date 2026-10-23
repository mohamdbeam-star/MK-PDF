import SwiftUI
import PDFKit

struct ToolsInspector: View {
    @ObservedObject var editor: EditorModel
    @ObservedObject var document: PDFFileDocument

    var body: some View {
        VStack(spacing: 0) {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 4), spacing: 4) {
                ForEach(ToolPanel.allCases) { panel in
                    Button {
                        editor.panel = panel
                        editor.organizing = panel == .organize
                    } label: {
                        VStack(spacing: 3) {
                            Image(systemName: panel.symbol).font(.system(size: 15)).frame(height: 18)
                            Text(panel.title).font(.system(size: 9.5)).lineLimit(1).minimumScaleFactor(0.8)
                        }
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background(editor.panel == panel ? Color.accentColor.opacity(0.18) : Color.clear, in: RoundedRectangle(cornerRadius: 7))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help(panel.title)
                }
            }
            .padding(8)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    // The selected annotation's properties come first so they're visible without scrolling.
                    if let a = editor.selectedAnnotation, editor.panel != .forms {
                        AnnotationInspector(editor: editor, annotation: a, revision: document.revision)
                            .padding(10)
                            .background(Color.accentColor.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
                    }
                    Text(editor.panel.title).font(.title3.bold())
                    switch editor.panel {
                    case .comment: CommentPanel(editor: editor)
                    case .fillSign: FillSignPanel(editor: editor)
                    case .edit: EditPanel(editor: editor)
                    case .organize: OrganizePanel(editor: editor)
                    case .forms: FormsPanel(editor: editor, document: document)
                    case .redact: RedactPanel(editor: editor, document: document)
                    case .protect: ProtectPanel(editor: editor, document: document)
                    case .ocr: OCRPanel(editor: editor)
                    case .compress: CompressPanel(editor: editor, document: document)
                    case .export: ExportPanel(editor: editor)
                    case .ai: AIPanel(editor: editor)
                    case .more: MorePanel(editor: editor)
                    }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .disabled(editor.busy != nil || document.pdf.isLocked)
    }
}

/// A grid of tool toggles.
struct ToolGrid: View {
    @ObservedObject var editor: EditorModel
    let tools: [Tool]

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 3), spacing: 6) {
            ForEach(tools) { tool in
                Button { editor.tool = editor.tool == tool ? .select : tool } label: {
                    VStack(spacing: 4) {
                        Image(systemName: tool.symbol).font(.system(size: 16))
                        Text(tool.title).font(.caption2).lineLimit(1).minimumScaleFactor(0.75)
                    }
                    .frame(maxWidth: .infinity, minHeight: 46)
                    .background(editor.tool == tool ? Color.accentColor.opacity(0.22) : Color.secondary.opacity(0.08),
                                in: RoundedRectangle(cornerRadius: 8))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(tool.title)
            }
        }
    }
}

struct ActionRow: View {
    let title: String
    let symbol: String
    var detail: String? = nil
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: symbol).frame(width: 20).foregroundStyle(Color.accentColor)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                    if let detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
                }
                Spacer()
            }
            .padding(.vertical, 7)
            .padding(.horizontal, 8)
            .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

struct SectionTitle: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View { Text(text.uppercased()).font(.caption.bold()).foregroundStyle(.secondary) }
}

struct StyleControls: View {
    @ObservedObject var editor: EditorModel
    var showsFont = true

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                ForEach(NSColor.highlightPalette, id: \.self) { c in
                    Circle().fill(Color(nsColor: c)).frame(width: 18, height: 18)
                        .overlay(Circle().stroke(Color.primary, lineWidth: editor.color == c ? 2 : 0))
                        .onTapGesture { editor.color = c }
                }
                ColorPicker("", selection: $editor.color.swiftUI).labelsHidden()
            }
            HStack {
                Text("Line").frame(width: 40, alignment: .leading)
                Slider(value: $editor.lineWidth, in: 0.5...12)
                Text(String(format: "%.1f", editor.lineWidth)).monospacedDigit().frame(width: 30)
            }
            if showsFont {
                HStack {
                    Text("Text").frame(width: 40, alignment: .leading)
                    Slider(value: $editor.fontSize, in: 6...48, step: 1)
                    Text("\(Int(editor.fontSize))").monospacedDigit().frame(width: 30)
                }
            }
        }
        .font(.callout)
    }
}

/// Properties of the selected annotation.
struct AnnotationInspector: View {
    @ObservedObject var editor: EditorModel
    let annotation: PDFAnnotation
    let revision: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label(annotation.displayName, systemImage: annotation.symbolName).font(.headline)
                Spacer()
                Button(role: .destructive) { editor.remove(annotation) } label: { Image(systemName: "trash") }
                    .buttonStyle(.borderless).help("Delete")
            }
            if let author = annotation.userName {
                Text("\(author)\(annotation.modificationDate.map { " · " + $0.formatted(date: .abbreviated, time: .shortened) } ?? "")")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if annotation is ImageStampAnnotation || annotation.type == "FreeText" {
                Menu {
                    ForEach(EditorModel.PlacementPages.allCases) { option in
                        Button(option.rawValue) { editor.place(annotation, on: option) }
                    }
                } label: { Label("Place on Other Pages", systemImage: "doc.on.doc") }
                .help("Copy this to the same position on other pages")
            }
            if !(annotation is ImageStampAnnotation) && annotation.type != "Widget" {
                Text(annotation.type == "FreeText" ? "Text" : "Comment").font(.caption.bold())
                TextEditor(text: Binding(
                    get: { annotation.contents ?? "" },
                    set: { value in editor.editContinuously(annotation) { $0.contents = value } }
                ))
                .font(.body)
                .frame(minHeight: 70, maxHeight: 160)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.3)))
                .onDisappear { editor.endEditingSession() }

                HStack {
                    Text("Color").font(.callout)
                    Spacer()
                    ForEach(NSColor.highlightPalette, id: \.self) { c in
                        Circle().fill(Color(nsColor: c)).frame(width: 16, height: 16)
                            .onTapGesture { applyColor(c) }
                    }
                }
                if annotation.type == "FreeText" {
                    Stepper("Font size \(Int(annotation.font?.pointSize ?? 12))") {
                        editor.modify(annotation, name: "Font Size") { a in a.font = a.font?.withSize((a.font?.pointSize ?? 12) + 1) }
                    } onDecrement: {
                        editor.modify(annotation, name: "Font Size") { a in a.font = a.font?.withSize(max(4, (a.font?.pointSize ?? 12) - 1)) }
                    }
                    .font(.callout)
                }
                if ["Ink", "Square", "Circle", "Line"].contains(annotation.type ?? "") {
                    Stepper("Line width \(String(format: "%.1f", annotation.border?.lineWidth ?? 1))") {
                        setWidth(+0.5)
                    } onDecrement: {
                        setWidth(-0.5)
                    }
                    .font(.callout)
                }
            }
        }
    }

    private func applyColor(_ c: NSColor) {
        editor.modify(annotation, name: "Color") { a in
            switch a.type {
            case "FreeText": a.fontColor = c
            case "Highlight": a.color = c.withAlphaComponent(0.45)
            default: a.color = c
            }
        }
    }

    private func setWidth(_ delta: CGFloat) {
        editor.modify(annotation, name: "Line Width") { a in
            let border = a.border ?? PDFBorder()
            border.lineWidth = max(0.5, border.lineWidth + delta)
            a.border = border
        }
    }
}
