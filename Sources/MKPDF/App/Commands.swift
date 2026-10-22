import SwiftUI
import PDFKit

struct MKPDFCommands: Commands {
    @FocusedObject private var editor: EditorModel?
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        CommandGroup(after: .newItem) {
            Button("Home") { openWindow(id: "home") }.keyboardShortcut("0", modifiers: [.command, .shift])
            Divider()
            Button("Combine Files…") { openWindow(id: "combine") }
            Menu("Create PDF") {
                Button("From Images…") { Creator.fromImages() }
                Button("From Document…") { Creator.fromDocument() }
                Button("From Web Page…") { Creator.fromWebPage() }
                Button("From Clipboard") { Creator.fromClipboard() }.keyboardShortcut("n", modifiers: [.command, .option])
            }
        }
        CommandGroup(replacing: .printItem) {
            Button("Print…") { editor?.printDocument() }.keyboardShortcut("p").disabled(editor == nil)
        }
        CommandGroup(after: .pasteboard) {
            Divider()
            Button("Delete Annotation") { editor?.deleteSelectedAnnotation() }.disabled(editor?.selectedAnnotation == nil)
            Button("Find…") { editor?.sidebar = .search; editor?.columnVisibility = .all }.keyboardShortcut("f").disabled(editor == nil)
        }
        CommandGroup(after: .sidebar) {
            Button("Zoom In") { editor?.zoomIn() }.keyboardShortcut("+")
            Button("Zoom Out") { editor?.zoomOut() }.keyboardShortcut("-")
            Button("Actual Size") { editor?.zoom(to: 100) }.keyboardShortcut("0")
            Button("Fit Page") { editor?.zoomToFit() }.keyboardShortcut("9")
            Button("Fit Width") { editor?.zoomToFitWidth() }.keyboardShortcut("8")
            Divider()
            Button("Single Page") { editor?.displayMode = .singlePage }
            Button("Continuous") { editor?.displayMode = .singlePageContinuous }
            Button("Two Pages") { editor?.displayMode = .twoUpContinuous }
            Divider()
            Button("Rotate Page Clockwise") { editor?.rotateView(90) }.keyboardShortcut("r")
            Button("Rotate Page Counterclockwise") { editor?.rotateView(-90) }.keyboardShortcut("l")
            Divider()
            Button("Read Mode") { editor?.enterReadMode() }.keyboardShortcut("h", modifiers: [.command, .control])
            Button((editor?.nightMode ?? false) ? "Turn Off Night Mode" : "Night Mode") { editor?.nightMode.toggle() }
            Button("Show Tools Panel") { editor?.showInspector.toggle() }.keyboardShortcut("t", modifiers: [.command, .option])
        }
        CommandMenu("Go") {
            Button("Next Page") { editor.map { $0.go(to: $0.pageIndex + 1) } }.keyboardShortcut(.downArrow, modifiers: [.command, .option])
            Button("Previous Page") { editor.map { $0.go(to: $0.pageIndex - 1) } }.keyboardShortcut(.upArrow, modifiers: [.command, .option])
            Button("First Page") { editor?.go(to: 0) }.keyboardShortcut(.upArrow, modifiers: .command)
            Button("Last Page") { editor.map { $0.go(to: $0.pageCount - 1) } }.keyboardShortcut(.downArrow, modifiers: .command)
            Button("Go to Page…") {
                guard let editor, let s = Panels.prompt("Go to Page", value: "\(editor.pageIndex + 1)"), let n = Int(s) else { return }
                editor.go(to: n - 1)
            }
            .keyboardShortcut("g", modifiers: [.command, .option])
        }
        CommandMenu("Tools") {
            Button("Edit Text & Images") { activate(.edit, tool: .editContent) }.keyboardShortcut("e", modifiers: [.command, .shift])
            Divider()
            Button("Select") { editor?.tool = .select }
            Button("Highlight") { activate(.comment, tool: .highlight) }.keyboardShortcut("h", modifiers: [.command, .shift])
            Button("Sticky Note") { activate(.comment, tool: .note) }.keyboardShortcut("n", modifiers: [.command, .shift])
            Button("Add Text") { activate(.comment, tool: .text) }.keyboardShortcut("t", modifiers: [.command, .shift])
            Button("Draw") { activate(.comment, tool: .ink) }
            Divider()
            ForEach(ToolPanel.allCases) { panel in
                Button(panel.title) { activate(panel, tool: nil) }
            }
        }
    }

    private func activate(_ panel: ToolPanel, tool: Tool?) {
        guard let editor else { return }
        editor.panel = panel
        editor.showInspector = true
        if panel == .organize { editor.organizing = true }
        if let tool { editor.organizing = false; editor.tool = tool }
    }
}
