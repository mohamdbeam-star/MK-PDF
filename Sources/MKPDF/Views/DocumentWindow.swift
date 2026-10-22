import SwiftUI
import PDFKit

struct DocumentWindow: View {
    @ObservedObject var document: PDFFileDocument
    let fileURL: URL?
    @StateObject private var editor: EditorModel
    @Environment(\.undoManager) private var undoManager

    init(document: PDFFileDocument, fileURL: URL?) {
        self.document = document
        self.fileURL = fileURL
        _editor = StateObject(wrappedValue: EditorModel(document: document))
    }

    var body: some View {
        NavigationSplitView(columnVisibility: $editor.columnVisibility) {
            SidebarView(editor: editor, document: document)
                .navigationSplitViewColumnWidth(min: 170, ideal: 210, max: 340)
        } detail: {
            ZStack {
                if document.pdf.isLocked {
                    UnlockView(editor: editor)
                } else if editor.organizing {
                    OrganizeView(editor: editor, document: document)
                } else {
                    PDFKitView(editor: editor, document: document)
                }
                if let busy = editor.busy { BusyOverlay(title: busy, progress: editor.progress) }
            }
            .frame(minWidth: 420, minHeight: 400)
            .inspector(isPresented: $editor.showInspector) {
                ToolsInspector(editor: editor, document: document)
                    .inspectorColumnWidth(min: 270, ideal: 300, max: 420)
            }
        }
        .toolbar { MainToolbar(editor: editor, document: document) }
        .searchable(text: $editor.searchText, placement: .toolbar, prompt: "Find in document")
        .onSubmit(of: .search) { editor.runSearch() }
        .focusedSceneObject(editor)
        .sheet(item: $editor.sheet) { sheet in
            SheetHost(sheet: sheet, editor: editor, document: document)
        }
        .onAppear {
            editor.undoManager = undoManager
            editor.fileURL = fileURL
        }
        .onChange(of: fileURL) { _, url in editor.fileURL = url }
        .onChange(of: undoManager) { _, manager in editor.undoManager = manager }
    }
}

struct BusyOverlay: View {
    let title: String
    let progress: Double?

    var body: some View {
        ZStack {
            Color.black.opacity(0.15).ignoresSafeArea()
            VStack(spacing: 12) {
                if let progress, progress > 0 {
                    ProgressView(value: progress).frame(width: 220)
                } else {
                    ProgressView()
                }
                Text(title).font(.headline)
            }
            .padding(24)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
        }
    }
}

struct UnlockView: View {
    @ObservedObject var editor: EditorModel
    @State private var password = ""
    @State private var failed = false

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "lock.doc").font(.system(size: 48)).foregroundStyle(.secondary)
            Text("This document is password protected").font(.title3.bold())
            SecureField("Password", text: $password).frame(width: 240).onSubmit(unlock)
            if failed { Text("Incorrect password").foregroundStyle(.red).font(.callout) }
            Button("Unlock", action: unlock).keyboardShortcut(.defaultAction)
        }
        .padding(40)
    }

    private func unlock() {
        let pdf = editor.document.pdf
        if pdf.unlock(withPassword: password) {
            // Keep the protection when saving again.
            editor.document.security = SecuritySettings(userPassword: password, ownerPassword: password, permissions: SecuritySettings.allPermissions)
            editor.document.revision += 1
            editor.go(to: 0)
        } else {
            failed = true
        }
    }
}

struct MainToolbar: ToolbarContent {
    @ObservedObject var editor: EditorModel
    @ObservedObject var document: PDFFileDocument
    @State private var pageField = ""

    var body: some ToolbarContent {
        ToolbarItemGroup(placement: .navigation) {
            Button { editor.go(to: editor.pageIndex - 1) } label: { Image(systemName: "chevron.up") }
                .help("Previous Page").disabled(editor.pageIndex == 0)
            Button { editor.go(to: editor.pageIndex + 1) } label: { Image(systemName: "chevron.down") }
                .help("Next Page").disabled(editor.pageIndex >= document.pdf.pageCount - 1)
            HStack(spacing: 4) {
                TextField("", text: $pageField)
                    .frame(width: 38)
                    .multilineTextAlignment(.center)
                    .onSubmit { if let n = Int(pageField) { editor.go(to: n - 1) } }
                Text("/ \(document.pdf.pageCount)").foregroundStyle(.secondary).monospacedDigit()
            }
            .onAppear { pageField = "\(editor.pageIndex + 1)" }
            .onChange(of: editor.pageIndex) { _, i in pageField = "\(i + 1)" }
        }

        ToolbarItemGroup {
            Menu {
                Button("Fit Page") { editor.zoomToFit() }
                Button("Fit Width") { editor.zoomToFitWidth() }
                Divider()
                ForEach([50, 75, 100, 125, 150, 200, 300, 400], id: \.self) { p in
                    Button("\(p)%") { editor.zoom(to: p) }
                }
                Divider()
                Picker("Page Display", selection: $editor.displayMode) {
                    Text("Single Page").tag(PDFDisplayMode.singlePage)
                    Text("Single Page Continuous").tag(PDFDisplayMode.singlePageContinuous)
                    Text("Two Pages").tag(PDFDisplayMode.twoUp)
                    Text("Two Pages Continuous").tag(PDFDisplayMode.twoUpContinuous)
                }
            } label: {
                Text("\(editor.scalePercent)%").monospacedDigit().frame(minWidth: 44)
            } primaryAction: {
                editor.zoomToFit()
            }
            .help("Zoom and page display")
            Button { editor.zoomOut() } label: { Image(systemName: "minus.magnifyingglass") }.help("Zoom Out")
            Button { editor.zoomIn() } label: { Image(systemName: "plus.magnifyingglass") }.help("Zoom In")
        }

        ToolbarItemGroup {
            ForEach([Tool.select, .hand, .editContent, .highlight, .note, .text, .ink], id: \.self) { tool in
                Toggle(isOn: Binding(get: { editor.tool == tool }, set: {
                    editor.tool = $0 ? tool : .select
                    if tool == .editContent { editor.panel = .edit; editor.showInspector = true; editor.organizing = false }
                })) {
                    Label(tool.title, systemImage: tool.symbol)
                }
                .help(tool.title)
            }
            Button {
                editor.panel = .fillSign
                editor.showInspector = true
            } label: { Label("Sign", systemImage: "signature") }
                .help("Fill & Sign")
        }

        ToolbarItemGroup {
            Toggle(isOn: $editor.organizing) { Label("Organize Pages", systemImage: "square.grid.3x3") }
                .help("Organize Pages")
            if let url = editor.fileURL {
                ShareLink(item: url).help("Share")
            }
            Button { editor.showInspector.toggle() } label: { Label("All Tools", systemImage: "sidebar.right") }
                .help("Show or hide the tools panel")
        }
    }
}

struct SheetHost: View {
    let sheet: EditorSheet
    @ObservedObject var editor: EditorModel
    @ObservedObject var document: PDFFileDocument

    var body: some View {
        switch sheet {
        case .signature: SignatureCaptureView(kind: .signature) { editor.armSignature($0, kind: "Signature") }
        case .initials: SignatureCaptureView(kind: .initials) { editor.armSignature($0, kind: "Initials") }
        case .watermark: WatermarkSheet(editor: editor)
        case .headerFooter: HeaderFooterSheet(editor: editor, bates: false)
        case .batesNumbers: HeaderFooterSheet(editor: editor, bates: true)
        case .split: SplitSheet(editor: editor)
        case .properties: PropertiesSheet(editor: editor, document: document)
        case .unlock: EmptyView()
        }
    }
}
