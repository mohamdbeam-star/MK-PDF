import SwiftUI
import PDFKit
import AVFoundation
import MKPDFCore

enum Tool: String, CaseIterable, Identifiable {
    case select, hand, editContent
    case highlight, underline, strikeout, note, text, ink, rectangle, oval, line, arrow, eraser
    case stamp, image
    case check, cross, dot, date
    case whiteout, link, crop, redact
    case textField, checkbox, dropdown

    var id: String { rawValue }

    var title: String {
        switch self {
        case .select: return "Select"
        case .hand: return "Hand"
        case .editContent: return "Edit Text & Images"
        case .highlight: return "Highlight"
        case .underline: return "Underline"
        case .strikeout: return "Strikethrough"
        case .note: return "Sticky Note"
        case .text: return "Add Text"
        case .ink: return "Draw"
        case .rectangle: return "Rectangle"
        case .oval: return "Oval"
        case .line: return "Line"
        case .arrow: return "Arrow"
        case .eraser: return "Eraser"
        case .stamp: return "Stamp"
        case .image: return "Place Image"
        case .check: return "Checkmark"
        case .cross: return "Cross"
        case .dot: return "Dot"
        case .date: return "Date"
        case .whiteout: return "Whiteout"
        case .link: return "Link"
        case .crop: return "Crop"
        case .redact: return "Mark for Redaction"
        case .textField: return "Text Field"
        case .checkbox: return "Checkbox"
        case .dropdown: return "Dropdown"
        }
    }

    var symbol: String {
        switch self {
        case .select: return "cursorarrow"
        case .hand: return "hand.raised"
        case .editContent: return "character.cursor.ibeam"
        case .highlight: return "highlighter"
        case .underline: return "underline"
        case .strikeout: return "strikethrough"
        case .note: return "note.text"
        case .text: return "character.textbox"
        case .ink: return "scribble.variable"
        case .rectangle: return "rectangle"
        case .oval: return "circle"
        case .line: return "line.diagonal"
        case .arrow: return "arrow.up.right"
        case .eraser: return "eraser"
        case .stamp: return "seal"
        case .image: return "photo"
        case .check: return "checkmark"
        case .cross: return "xmark"
        case .dot: return "circle.fill"
        case .date: return "calendar"
        case .whiteout: return "rectangle.fill"
        case .link: return "link"
        case .crop: return "crop"
        case .redact: return "eye.slash"
        case .textField: return "character.cursor.ibeam"
        case .checkbox: return "checkmark.square"
        case .dropdown: return "filemenu.and.selection"
        }
    }

    /// Tools that work by dragging out a rectangle or line.
    var isDragShape: Bool {
        [.rectangle, .oval, .line, .arrow, .whiteout, .link, .crop, .redact, .textField, .checkbox, .dropdown].contains(self)
    }

    var isMarkup: Bool { [.highlight, .underline, .strikeout].contains(self) }
}

enum ToolPanel: String, CaseIterable, Identifiable {
    case comment, fillSign, edit, organize, forms, redact, protect, ocr, compress, export, ai, more
    var id: String { rawValue }

    var title: String {
        switch self {
        case .comment: return "Comment"
        case .fillSign: return "Fill & Sign"
        case .edit: return "Edit PDF"
        case .organize: return "Organize Pages"
        case .forms: return "Prepare Form"
        case .redact: return "Redact"
        case .protect: return "Protect"
        case .ocr: return "Scan & OCR"
        case .compress: return "Compress"
        case .export: return "Export PDF"
        case .ai: return "AI Assistant"
        case .more: return "More Tools"
        }
    }

    var symbol: String {
        switch self {
        case .comment: return "text.bubble"
        case .fillSign: return "signature"
        case .edit: return "square.and.pencil"
        case .organize: return "square.grid.2x2"
        case .forms: return "list.bullet.rectangle"
        case .redact: return "eye.slash"
        case .protect: return "lock"
        case .ocr: return "text.viewfinder"
        case .compress: return "arrow.down.right.and.arrow.up.left"
        case .export: return "square.and.arrow.up"
        case .ai: return "sparkles"
        case .more: return "ellipsis.circle"
        }
    }
}

enum SidebarMode: String, CaseIterable, Identifiable {
    case thumbnails, bookmarks, comments, search
    var id: String { rawValue }
    var symbol: String {
        switch self {
        case .thumbnails: return "square.grid.2x2"
        case .bookmarks: return "bookmark"
        case .comments: return "text.bubble"
        case .search: return "magnifyingglass"
        }
    }
    var title: String { rawValue.capitalized }
}

enum EditorSheet: String, Identifiable {
    case signature, initials, watermark, headerFooter, batesNumbers, split, properties, unlock
    var id: String { rawValue }
}

final class EditorModel: ObservableObject {
    let document: PDFFileDocument
    weak var pdfView: MKPDFView?
    var undoManager: UndoManager?
    var fileURL: URL?

    @Published var tool: Tool = .select { didSet { pdfView?.toolDidChange() } }
    @Published var color: NSColor = .systemYellow
    @Published var lineWidth: CGFloat = 2
    @Published var fontSize: CGFloat = 14
    @Published var selectedAnnotation: PDFAnnotation? { didSet { pdfView?.overlay.needsDisplay = true } }

    @Published var sidebar: SidebarMode = .thumbnails
    @Published var columnVisibility: NavigationSplitViewVisibility = .all
    @Published var panel: ToolPanel = .edit
    @Published var showInspector = true
    @Published var organizing = false
    @Published var sheet: EditorSheet?

    @Published var pageIndex = 0
    @Published var scalePercent = 100
    @Published var displayMode: PDFDisplayMode = .singlePageContinuous { didSet { pdfView?.displayMode = displayMode } }
    @Published var nightMode = false
    /// Two-page layouts read right to left (Arabic, Hebrew books).
    @Published var rightToLeft = false { didSet { pdfView?.displaysRTL = rightToLeft } }

    @Published var busy: String?
    @Published var progress: Double?

    /// Edit Text & Images: the selected image/drawing, the style of the paragraph being edited,
    /// and whether the next click adds new text.
    @Published var editObject: (PDFPage, GraphicObject)? { didSet { pdfView?.overlay.needsDisplay = true } }
    @Published var editStyle: EditStyle? { didSet { if editStyle != nil, editStyle != oldValue { pdfView?.layoutSession() } } }
    @Published var addingContentText = false

    /// Picture armed for the stamp/image tool.
    @Published var placingImage: NSImage?
    var placingKind = "Image"

    @Published var searchText = ""
    @Published var searchResults: [PDFSelection] = []
    @Published var searchCaseSensitive = false

    let speech = AVSpeechSynthesizer()
    @Published var speaking = false

    var author: String {
        let stored = UserDefaults.standard.string(forKey: "authorName") ?? ""
        return stored.isEmpty ? NSFullUserName() : stored
    }

    init(document: PDFFileDocument) {
        self.document = document
    }

    var pdf: PDFDocument { document.pdf }
    var pageCount: Int { pdf.pageCount }
    var currentPage: PDFPage? { pdfView?.currentPage ?? pdf.page(at: min(pageIndex, max(0, pageCount - 1))) }
    var documentName: String { fileURL?.baseName ?? "Untitled" }

    // MARK: - View wiring

    func attach(_ view: MKPDFView) {
        pdfView = view
        view.displayMode = displayMode
        if let page = pdf.page(at: pageIndex) { view.go(to: page) }
    }

    func viewDidChangePage() {
        guard let view = pdfView, let page = view.currentPage else { return }
        let index = pdf.index(for: page)
        if index != NSNotFound, index != pageIndex { pageIndex = index }
    }

    func viewDidChangeScale() {
        guard let view = pdfView else { return }
        let percent = Int((view.scaleFactor * 100).rounded())
        if percent != scalePercent { scalePercent = percent }
    }

    /// Records that the document changed so dependent views refresh.
    func changed(_ page: PDFPage? = nil) {
        document.revision += 1
        if let page { pdfView?.annotationsChanged(on: page) }
        pdfView?.overlay.needsDisplay = true
    }

    private func registerUndo(_ name: String, _ handler: @escaping (EditorModel) -> Void) {
        guard let undoManager else { return }
        undoManager.registerUndo(withTarget: self, handler: handler)
        undoManager.setActionName(name)
    }

    // MARK: - Navigation & zoom

    func go(to index: Int) {
        guard let page = pdf.page(at: max(0, min(index, pageCount - 1))) else { return }
        pageIndex = pdf.index(for: page)
        pdfView?.go(to: page)
    }

    func go(to selection: PDFSelection) {
        pdfView?.setCurrentSelection(selection, animate: true)
        pdfView?.go(to: selection)
    }

    func reveal(_ annotation: PDFAnnotation) {
        guard let page = annotation.page else { return }
        pdfView?.go(to: annotation.bounds.insetBy(dx: -40, dy: -40), on: page)
        selectedAnnotation = annotation
    }

    func zoomIn() { pdfView?.zoomIn(nil) }
    func zoomOut() { pdfView?.zoomOut(nil) }
    func zoom(to percent: Int) {
        pdfView?.autoScales = false
        pdfView?.scaleFactor = CGFloat(percent) / 100
    }
    func zoomToFit() {
        guard let view = pdfView else { return }
        view.autoScales = true
        view.scaleFactor = view.scaleFactorForSizeToFit
    }
    func zoomToFitWidth() {
        guard let view = pdfView, let page = currentPage else { return }
        let width = page.displaySize.width + 20
        view.autoScales = false
        view.scaleFactor = max(0.1, (view.bounds.width - 30) / width)
    }

    func rotateView(_ degrees: Int) {
        guard let page = currentPage else { return }
        rotate([page], by: degrees)
    }

    // MARK: - Annotations (undoable)

    func add(_ a: PDFAnnotation, to page: PDFPage, select: Bool = true, name: String = "Add Annotation") {
        if a.userName == nil { a.userName = author }
        a.modificationDate = Date()
        page.addAnnotation(a)
        changed(page)
        registerUndo(name) { $0.remove(a, name: name) }
        if select && a.isComment { selectedAnnotation = a }
    }

    func remove(_ a: PDFAnnotation, name: String = "Delete Annotation") {
        guard let page = a.page else { return }
        page.removeAnnotation(a)
        if selectedAnnotation === a { selectedAnnotation = nil }
        changed(page)
        registerUndo(name) { $0.add(a, to: page, select: false, name: name) }
    }

    /// Applies `change` to an annotation and registers an undo that restores its previous state.
    func modify(_ a: PDFAnnotation, name: String = "Edit Annotation", _ change: (PDFAnnotation) -> Void) {
        let before = AnnotationState(a)
        change(a)
        a.modificationDate = Date()
        changed(a.page)
        registerUndo(name) { $0.restore(a, to: before, name: name) }
    }

    /// Registers undo for a change already made (e.g. after a drag finished).
    func didModify(_ a: PDFAnnotation, from before: AnnotationState, name: String) {
        changed(a.page)
        registerUndo(name) { $0.restore(a, to: before, name: name) }
    }

    private func restore(_ a: PDFAnnotation, to state: AnnotationState, name: String) {
        let now = AnnotationState(a)
        state.apply(to: a)
        changed(a.page)
        registerUndo(name) { $0.restore(a, to: now, name: name) }
    }

    private var editingSession: ObjectIdentifier?

    /// Edits text-like properties from the inspector, grouping a typing session into one undo step.
    func editContinuously(_ a: PDFAnnotation, _ change: (PDFAnnotation) -> Void) {
        if editingSession != ObjectIdentifier(a) {
            editingSession = ObjectIdentifier(a)
            let before = AnnotationState(a)
            registerUndo("Edit Annotation") { $0.restore(a, to: before, name: "Edit Annotation") }
        }
        change(a)
        a.modificationDate = Date()
        changed(a.page)
    }

    func endEditingSession() { editingSession = nil }

    var allComments: [PDFAnnotation] {
        pdf.pages.flatMap { $0.annotations.filter(\.isComment) }
    }

    func markup(_ selection: PDFSelection, tool: Tool) {
        let subtype: PDFAnnotationSubtype = tool == .highlight ? .highlight : tool == .underline ? .underline : .strikeOut
        let lineColor = tool == .highlight ? color.withAlphaComponent(0.45) : color
        undoManager?.beginUndoGrouping()
        for line in selection.selectionsByLine() {
            for page in line.pages {
                let bounds = line.bounds(for: page)
                guard bounds.width > 1 else { continue }
                let a = PDFAnnotation(bounds: bounds, forType: subtype, withProperties: nil)
                a.color = lineColor
                add(a, to: page, select: false, name: tool.title)
            }
        }
        undoManager?.endUndoGrouping()
        undoManager?.setActionName(tool.title)
    }

    func addNote(at point: CGPoint, on page: PDFPage) {
        let a = PDFAnnotation(bounds: CGRect(x: point.x, y: point.y - 24, width: 24, height: 24), forType: .text, withProperties: nil)
        a.iconType = .comment
        a.color = color == .black ? .systemYellow : color
        a.contents = ""
        add(a, to: page, name: "Add Note")
        tool = .select
    }

    func addTextBox(_ text: String, at point: CGPoint, on page: PDFPage, size: CGFloat? = nil, textColor: NSColor? = nil, name: String = "Add Text") {
        let fontSize = size ?? self.fontSize
        let font = NSFont(name: "Helvetica", size: fontSize) ?? .systemFont(ofSize: fontSize)
        let measured = (text as NSString).size(withAttributes: [.font: font])
        let w = max(measured.width + 12, 24), h = measured.height + 8
        let a = PDFAnnotation(bounds: CGRect(x: point.x, y: point.y - h / 2, width: w, height: h), forType: .freeText, withProperties: nil)
        a.contents = text
        a.font = font
        a.fontColor = textColor ?? (color == .systemYellow ? .black : color)
        a.color = .clear
        let border = PDFBorder()
        border.lineWidth = 0
        a.border = border
        add(a, to: page, name: name)
    }

    func addInk(_ points: [CGPoint], on page: PDFPage) {
        guard points.count > 1 else { return }
        let xs = points.map(\.x), ys = points.map(\.y)
        let pad = lineWidth + 2
        let bounds = CGRect(x: xs.min()! - pad, y: ys.min()! - pad,
                            width: xs.max()! - xs.min()! + pad * 2, height: ys.max()! - ys.min()! + pad * 2)
        let path = NSBezierPath()
        path.move(to: CGPoint(x: points[0].x - bounds.minX, y: points[0].y - bounds.minY))
        for p in points.dropFirst() { path.line(to: CGPoint(x: p.x - bounds.minX, y: p.y - bounds.minY)) }
        path.lineWidth = lineWidth
        path.lineCapStyle = .round
        path.lineJoinStyle = .round
        let a = PDFAnnotation(bounds: bounds, forType: .ink, withProperties: nil)
        a.add(path)
        a.color = color
        let border = PDFBorder()
        border.lineWidth = lineWidth
        a.border = border
        add(a, to: page, select: false, name: "Draw")
    }

    /// Finishes a drag-shaped tool between `start` and `end` (page space).
    func finishShape(_ tool: Tool, page: PDFPage, from start: CGPoint, to end: CGPoint) {
        var rect = CGRect(x: min(start.x, end.x), y: min(start.y, end.y), width: abs(end.x - start.x), height: abs(end.y - start.y))
        let tiny = rect.width < 4 && rect.height < 4
        let border = PDFBorder()
        border.lineWidth = lineWidth
        switch tool {
        case .rectangle, .oval:
            guard !tiny else { return }
            let a = PDFAnnotation(bounds: rect, forType: tool == .rectangle ? .square : .circle, withProperties: nil)
            a.color = color
            a.border = border
            add(a, to: page, name: tool.title)
        case .line, .arrow:
            guard !tiny else { return }
            let pad = lineWidth * 4 + 6
            let bounds = rect.insetBy(dx: -pad, dy: -pad)
            let a = PDFAnnotation(bounds: bounds, forType: .line, withProperties: nil)
            a.startPoint = CGPoint(x: start.x - bounds.minX, y: start.y - bounds.minY)
            a.endPoint = CGPoint(x: end.x - bounds.minX, y: end.y - bounds.minY)
            if tool == .arrow { a.endLineStyle = .closedArrow; a.interiorColor = color }
            a.color = color
            a.border = border
            add(a, to: page, name: tool.title)
        case .whiteout:
            guard !tiny else { return }
            let a = PDFAnnotation(bounds: rect, forType: .square, withProperties: nil)
            a.color = .white
            a.interiorColor = .white
            let none = PDFBorder()
            none.lineWidth = 0
            a.border = none
            a.contents = "Whiteout"
            add(a, to: page, select: false, name: "Whiteout")
        case .redact:
            guard !tiny else { return }
            add(RedactionMark.make(rect), to: page, select: false, name: "Mark for Redaction")
        case .link:
            guard !tiny else { return }
            addLink(rect, on: page)
        case .crop:
            guard !tiny else { return }
            crop(rect, page: page)
            self.tool = .select
        case .textField, .checkbox, .dropdown:
            if tiny {
                let size = tool == .checkbox ? CGSize(width: 16, height: 16) : CGSize(width: 180, height: 22)
                rect = CGRect(origin: CGPoint(x: start.x, y: start.y - size.height), size: size)
            }
            addFormField(tool, rect: rect, on: page)
        default:
            break
        }
    }

    func placeImage(at point: CGPoint, on page: PDFPage) {
        guard let image = placingImage, image.size.width > 0 else { return }
        let maxWidth: CGFloat = placingKind == "Stamp" ? 200 : placingKind == "Initials" ? 70 : 170
        let scale = min(maxWidth / image.size.width, 1.5)
        var size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        if page.normalizedRotation % 180 != 0 { size = CGSize(width: size.height, height: size.width) }
        let rect = CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height)
        let a = ImageStampAnnotation(image: image, bounds: rect, kind: placingKind)
        add(a, to: page, select: true, name: "Place \(placingKind)")
        selectedAnnotation = a
        tool = .select
    }

    func placeMark(_ tool: Tool, at point: CGPoint, on page: PDFPage) {
        switch tool {
        case .check: addTextBox("✓", at: point, on: page, size: max(fontSize, 16), textColor: .black, name: "Checkmark")
        case .cross: addTextBox("✗", at: point, on: page, size: max(fontSize, 16), textColor: .black, name: "Cross")
        case .dot: addTextBox("●", at: point, on: page, size: max(fontSize * 0.7, 8), textColor: .black, name: "Dot")
        case .date: addTextBox(Date().formatted(date: .numeric, time: .omitted), at: point, on: page, textColor: .black, name: "Date")
        default: break
        }
    }

    func addLink(_ rect: CGRect, on page: PDFPage) {
        guard let target = Panels.prompt("Add Link", message: "Enter a web address, or a page number to link inside this document.", placeholder: "https://example.com or 3"),
              !target.isEmpty else { return }
        let a = PDFAnnotation(bounds: rect, forType: .link, withProperties: nil)
        if let n = Int(target), let dest = pdf.page(at: n - 1) {
            a.destination = PDFDestination(page: dest, at: CGPoint(x: 0, y: dest.bounds(for: .cropBox).maxY))
        } else {
            let address = target.contains("://") || target.hasPrefix("mailto:") ? target : "https://\(target)"
            guard let url = URL(string: address) else { return }
            a.url = url
        }
        add(a, to: page, select: false, name: "Add Link")
    }

    private var fieldCounter = 0

    func addFormField(_ tool: Tool, rect: CGRect, on page: PDFPage) {
        fieldCounter += 1
        let a = PDFAnnotation(bounds: rect, forType: .widget, withProperties: nil)
        a.backgroundColor = NSColor.systemBlue.withAlphaComponent(0.08)
        let border = PDFBorder()
        border.lineWidth = 1
        a.border = border
        a.color = .systemBlue
        switch tool {
        case .checkbox:
            a.widgetFieldType = .button
            a.widgetControlType = .checkBoxControl
            a.fieldName = "Check\(fieldCounter)"
            a.buttonWidgetState = .offState
        case .dropdown:
            a.widgetFieldType = .choice
            a.fieldName = "Choice\(fieldCounter)"
            let options = Panels.prompt("Dropdown Options", message: "Separate the choices with commas.", value: "Option 1, Option 2, Option 3") ?? "Option 1"
            a.choices = options.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            a.widgetStringValue = a.choices?.first
            a.isListChoice = false
            a.font = .systemFont(ofSize: 11)
        default:
            a.widgetFieldType = .text
            a.fieldName = "Text\(fieldCounter)"
            a.font = .systemFont(ofSize: 11)
            a.isMultiline = rect.height > 30
        }
        add(a, to: page, select: false, name: "Add \(tool.title)")
        selectedAnnotation = a
    }

    /// Replaces the selected text: covers it with white and types the new text over it.
    func replaceSelectedText() {
        guard let selection = pdfView?.currentSelection, let original = selection.string, !original.isEmpty,
              let page = selection.pages.first else {
            Panels.alert("Select some text first", "Use the Select tool to highlight the text you want to change.")
            return
        }
        guard let replacement = Panels.prompt("Edit Text", message: "Replace the selected text with:", value: original) else { return }
        let bounds = selection.bounds(for: page)
        let size = selection.attributedString?.attribute(.font, at: 0, effectiveRange: nil).flatMap { ($0 as? NSFont)?.pointSize } ?? max(8, bounds.height * 0.8)
        undoManager?.beginUndoGrouping()
        let cover = PDFAnnotation(bounds: bounds.insetBy(dx: -1, dy: -1), forType: .square, withProperties: nil)
        cover.color = .white
        cover.interiorColor = .white
        let none = PDFBorder()
        none.lineWidth = 0
        cover.border = none
        cover.contents = "Whiteout"
        add(cover, to: page, select: false, name: "Edit Text")
        let font = NSFont(name: "Helvetica", size: size) ?? .systemFont(ofSize: size)
        let width = max((replacement as NSString).size(withAttributes: [.font: font]).width + 8, bounds.width)
        let text = PDFAnnotation(bounds: CGRect(x: bounds.minX - 2, y: bounds.minY - 2, width: width, height: bounds.height + 4), forType: .freeText, withProperties: nil)
        text.contents = replacement
        text.font = font
        text.fontColor = .black
        text.color = .clear
        text.border = none
        add(text, to: page, select: false, name: "Edit Text")
        undoManager?.endUndoGrouping()
        undoManager?.setActionName("Edit Text")
        pdfView?.clearSelection()
    }

    func deleteSelectedAnnotation() {
        if let a = selectedAnnotation { remove(a) }
    }

    func removeAll(where predicate: (PDFAnnotation) -> Bool, name: String) {
        let targets = pdf.pages.flatMap { $0.annotations.filter(predicate) }
        guard !targets.isEmpty else { return }
        undoManager?.beginUndoGrouping()
        targets.forEach { remove($0, name: name) }
        undoManager?.endUndoGrouping()
        undoManager?.setActionName(name)
    }

    // MARK: - Pages (undoable)

    func rotate(_ pages: [PDFPage], by degrees: Int) {
        guard !pages.isEmpty else { return }
        for p in pages { p.rotation = ((p.rotation + degrees) % 360 + 360) % 360 }
        changed()
        pages.forEach { pdfView?.annotationsChanged(on: $0) }
        pdfView?.layoutDocumentView()
        registerUndo("Rotate Pages") { $0.rotate(pages, by: -degrees) }
    }

    func deletePages(_ indices: [Int]) {
        let sorted = Array(Set(indices)).sorted()
        guard !sorted.isEmpty else { return }
        guard sorted.count < pageCount else {
            Panels.alert("Can't delete every page", "A PDF needs at least one page.")
            return
        }
        let removed = sorted.compactMap { i in pdf.page(at: i).map { (i, $0) } }
        for i in sorted.reversed() { pdf.removePage(at: i) }
        selectedAnnotation = nil
        pageIndex = min(pageIndex, pageCount - 1)
        changed()
        registerUndo("Delete Pages") { $0.insertPages(removed) }
    }

    /// Inserts pages at the given indices (ascending order is applied).
    func insertPages(_ items: [(Int, PDFPage)], name: String = "Insert Pages") {
        let sorted = items.sorted { $0.0 < $1.0 }
        for (i, p) in sorted { pdf.insert(p, at: min(i, pageCount)) }
        changed()
        let indices = sorted.map { pdf.index(for: $0.1) }
        registerUndo(name) { $0.deletePages(indices) }
    }

    func setPageOrder(_ order: [PDFPage], name: String = "Move Pages") {
        let old = pdf.pages
        guard order.count == old.count, order != old else { return }
        for (target, page) in order.enumerated() {
            let current = pdf.index(for: page)
            if current != target { pdf.exchangePage(at: target, withPageAt: current) }
        }
        changed()
        pdfView?.layoutDocumentView()
        registerUndo(name) { $0.setPageOrder(old, name: name) }
    }

    func movePages(_ source: IndexSet, to destination: Int) {
        var order = pdf.pages
        order.move(fromOffsets: source, toOffset: destination)
        setPageOrder(order)
    }

    func insertBlankPage(after index: Int) {
        let size = pdf.page(at: index)?.bounds(for: .cropBox).size ?? PageFactory.letter
        insertPages([(index + 1, PageFactory.blank(size: size))], name: "Insert Blank Page")
        go(to: index + 1)
    }

    func duplicatePages(_ indices: [Int]) {
        guard let copy = PDFExporter.copy(of: pdf) else { return }
        let sorted = indices.sorted()
        var items: [(Int, PDFPage)] = []
        for (offset, i) in sorted.enumerated() {
            if let p = copy.page(at: i) { items.append((i + 1 + offset, p)) }
        }
        insertPages(items, name: "Duplicate Pages")
    }

    func insertFromFile(after index: Int) {
        let urls = Panels.open([.pdf] + Panels.imageTypes, multiple: true, title: "Choose PDFs or images to insert")
        guard !urls.isEmpty else { return }
        let pages = Combiner.pages(from: urls)
        guard !pages.isEmpty else { return }
        insertPages(pages.enumerated().map { (index + 1 + $0.offset, $0.element) }, name: "Insert Pages")
    }

    func replacePage(_ index: Int) {
        guard let url = Panels.open([.pdf] + Panels.imageTypes, title: "Choose the replacement page").first,
              let page = Combiner.pages(from: [url]).first, let old = pdf.page(at: index) else { return }
        undoManager?.beginUndoGrouping()
        insertPages([(index + 1, page)], name: "Replace Page")
        deletePages([pdf.index(for: old)])
        undoManager?.endUndoGrouping()
        undoManager?.setActionName("Replace Page")
    }

    func crop(_ rect: CGRect, page: PDFPage) {
        let applyAll = pageCount > 1 && Panels.confirm("Crop all pages?", message: "Apply the same crop to every page, or only this one.", ok: "All Pages")
        let targets = applyAll ? pdf.pages : [page]
        setCropBoxes(targets.map { ($0, rect.intersection($0.bounds(for: .mediaBox))) })
    }

    func setCropBoxes(_ items: [(PDFPage, CGRect)]) {
        let old = items.map { ($0.0, $0.0.bounds(for: .cropBox)) }
        for (p, r) in items where !r.isEmpty { p.setBounds(r, for: .cropBox) }
        changed()
        pdfView?.layoutDocumentView()
        registerUndo("Crop Pages") { $0.setCropBoxes(old) }
    }

    /// Swaps in a whole new document (OCR, compression, watermarks, …); undo swaps the old one back.
    func replaceDocument(with new: PDFDocument, name: String) {
        let old = document.pdf
        let oldPage = pageIndex
        selectedAnnotation = nil
        document.pdf = new
        changed()
        go(to: min(oldPage, new.pageCount - 1))
        registerUndo(name) { $0.replaceDocument(with: old, name: name) }
    }

    /// Runs `transform` on a flattened copy of the chosen pages and swaps the result in.
    func transformPages(_ name: String, indices: [Int]? = nil, _ transform: (PDFPage, Int) -> PDFPage?) {
        guard let copy = PDFExporter.copy(of: pdf) else { return }
        let targets = indices ?? Array(0..<copy.pageCount)
        for i in targets {
            guard let page = copy.page(at: i), let result = transform(page, i) else { continue }
            copy.replacePage(at: i, with: result)
        }
        replaceDocument(with: copy, name: name)
    }

    /// Writes a flattened copy containing only `indices`.
    func extractedDocument(_ indices: [Int]) -> PDFDocument? {
        guard let copy = PDFExporter.copy(of: pdf) else { return nil }
        let keep = Set(indices)
        for i in (0..<copy.pageCount).reversed() where !keep.contains(i) { copy.removePage(at: i) }
        return copy
    }

    func extractPages() {
        guard let text = Panels.prompt("Extract Pages", message: "Pages to extract (for example 1-3, 6).", value: "\(pageIndex + 1)"),
              let indices = PageRanges.parse(text, pageCount: pageCount) else { return }
        guard let doc = extractedDocument(indices) else { return }
        let deleteAfter = Panels.confirm("Delete extracted pages from this document?", ok: "Delete", destructive: true)
        DocumentLauncher.open(doc)
        if deleteAfter { deletePages(indices) }
    }

    // MARK: - Search

    func runSearch() {
        let query = searchText.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else {
            searchResults = []
            pdfView?.highlightedSelections = nil
            return
        }
        var options: NSString.CompareOptions = []
        if !searchCaseSensitive { options.insert(.caseInsensitive) }
        searchResults = pdf.findString(query, withOptions: options)
        for r in searchResults { r.color = NSColor.systemYellow.withAlphaComponent(0.6) }
        pdfView?.highlightedSelections = searchResults
        sidebar = .search
        columnVisibility = .all
        if let first = searchResults.first { go(to: first) }
    }

    // MARK: - Long-running work

    /// Shows a progress overlay while `work` runs off the main thread, then applies the result.
    func run<T>(_ title: String, work: @escaping (_ progress: @escaping (Double) -> Void) throws -> T, then: @escaping (T) -> Void) {
        busy = title
        progress = 0
        DispatchQueue.global(qos: .userInitiated).async {
            let result = Result { try work { value in DispatchQueue.main.async { self.progress = value } } }
            DispatchQueue.main.async {
                self.busy = nil
                self.progress = nil
                switch result {
                case .success(let value): then(value)
                case .failure(let error): Panels.alert("\(title) failed", error.localizedDescription)
                }
            }
        }
    }

    // MARK: - Misc

    func printDocument() {
        guard let data = try? PDFExporter.data(for: pdf), let copy = PDFDocument(data: data),
              let op = copy.printOperation(for: NSPrintInfo.shared, scalingMode: .pageScaleDownToFit, autoRotate: true) else { return }
        if let window = pdfView?.window {
            op.runModal(for: window, delegate: nil, didRun: nil, contextInfo: nil)
        } else {
            op.run()
        }
    }

    func toggleReadAloud() {
        if speech.isSpeaking {
            speech.stopSpeaking(at: .immediate)
            speaking = false
            return
        }
        let text = (pdfView?.currentSelection?.string).flatMap { $0.isEmpty ? nil : $0 }
            ?? (pageIndex..<pageCount).compactMap { pdf.page(at: $0)?.string }.joined(separator: "\n")
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            Panels.alert("Nothing to read", "This page has no text. Run Scan & OCR first if it's a scan.")
            return
        }
        speech.speak(AVSpeechUtterance(string: text))
        speaking = true
    }
}
