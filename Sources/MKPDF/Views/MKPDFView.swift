import AppKit
import PDFKit
import SwiftUI
import MKPDFCore

/// PDFView with MK PDF's editing tools: drawing, shapes, notes, placing images and moving annotations.
final class MKPDFView: PDFView {
    weak var editor: EditorModel?
    let overlay = AnnotationOverlay()

    enum Drag {
        case shape(page: PDFPage, start: CGPoint, current: CGPoint)
        case ink(page: PDFPage, points: [CGPoint])
        case move(annotation: PDFAnnotation, start: CGPoint, before: AnnotationState, resize: Bool, moved: Bool)
        case pan(start: NSPoint, origin: NSPoint)
    }

    enum EditDrag {
        case block(page: PDFPage, block: TextBlock, start: CGPoint, current: CGPoint)
        case object(page: PDFPage, object: GraphicObject, start: CGPoint, current: CGPoint, resize: Bool)
    }

    private(set) var drag: Drag?
    var editDrag: EditDrag?
    let contentEdit = ContentEditState()
    private var observedClipView: NSClipView?

    override init(frame: NSRect) {
        super.init(frame: frame)
        autoScales = true
        displaysPageBreaks = true
        pageBreakMargins = NSEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
        backgroundColor = .underPageBackgroundColor
        overlay.pdfView = self
        overlay.frame = bounds
        overlay.autoresizingMask = [.width, .height]
        addSubview(overlay)
        for name in [Notification.Name.PDFViewScaleChanged, .PDFViewPageChanged, .PDFViewDisplayModeChanged, .PDFViewDocumentChanged] {
            NotificationCenter.default.addObserver(self, selector: #selector(viewStateChanged(_:)), name: name, object: self)
        }
        NotificationCenter.default.addObserver(self, selector: #selector(annotationHit(_:)), name: .PDFViewAnnotationHit, object: self)
    }

    required init?(coder: NSCoder) { nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    override func layout() {
        super.layout()
        if subviews.last !== overlay { addSubview(overlay, positioned: .above, relativeTo: nil) }
        if let clip = documentView?.enclosingScrollView?.contentView, clip !== observedClipView {
            observedClipView = clip
            clip.postsBoundsChangedNotifications = true
            NotificationCenter.default.addObserver(self, selector: #selector(scrolled), name: NSView.boundsDidChangeNotification, object: clip)
        }
    }

    @objc private func scrolled() {
        overlay.needsDisplay = true
        layoutSession()
    }

    @objc private func viewStateChanged(_ note: Notification) {
        overlay.needsDisplay = true
        layoutSession()
        DispatchQueue.main.async { [weak self] in
            self?.editor?.viewDidChangePage()
            self?.editor?.viewDidChangeScale()
        }
    }

    /// Records the value of a form field before the user edits it, so filling forms can be undone.
    @objc private func annotationHit(_ note: Notification) {
        guard let a = note.userInfo?["PDFAnnotationHit"] as? PDFAnnotation, a.type == "Widget", let editor else { return }
        editor.didModify(a, from: AnnotationState(a), name: "Fill Form")
    }

    func toolDidChange() {
        drag = nil
        if editor?.tool != .editContent {
            commitSession()
            editor?.editObject = nil
            contentEdit.hovered = nil
        }
        if let tool = editor?.tool, !tool.isMarkup, tool != .select { clearSelection() }
        window?.invalidateCursorRects(for: self)
        overlay.needsDisplay = true
    }

    func applyNightMode(_ on: Bool) {
        wantsLayer = true
        let filters: [CIFilter] = on ? [CIFilter(name: "CIColorInvert")!, CIFilter(name: "CIHueAdjust", parameters: [kCIInputAngleKey: Double.pi])!] : []
        if (contentFilters.isEmpty) == on { contentFilters = filters }
    }

    // MARK: - Geometry

    private func location(_ event: NSEvent) -> (page: PDFPage, point: CGPoint)? {
        let viewPoint = convert(event.locationInWindow, from: nil)
        guard let page = page(for: viewPoint, nearest: true) else { return nil }
        return (page, convert(viewPoint, to: page))
    }

    /// Bottom-right corner (page space) used as the resize handle.
    static func handlePoint(_ a: PDFAnnotation) -> CGPoint { CGPoint(x: a.bounds.maxX, y: a.bounds.minY) }

    private func hitsHandle(_ a: PDFAnnotation, viewPoint: NSPoint) -> Bool {
        guard a.isResizable, let page = a.page else { return false }
        let handle = convert(Self.handlePoint(a), from: page)
        return abs(handle.x - viewPoint.x) < 9 && abs(handle.y - viewPoint.y) < 9
    }

    // MARK: - Mouse

    override func mouseDown(with event: NSEvent) {
        guard let editor else { return super.mouseDown(with: event) }
        let viewPoint = convert(event.locationInWindow, from: nil)
        guard bounds.contains(viewPoint) else { return } // stray events routed from elsewhere
        if contentEdit.session == nil { window?.makeFirstResponder(self) }
        guard let (page, point) = location(event) else { return super.mouseDown(with: event) }
        let tool = editor.tool

        switch tool {
        case .editContent:
            editMouseDown(event, page: page, point: point)
        case .select:
            if let selected = editor.selectedAnnotation, selected.page === page, hitsHandle(selected, viewPoint: viewPoint) {
                drag = .move(annotation: selected, start: point, before: AnnotationState(selected), resize: true, moved: false)
                return
            }
            if let hit = page.annotation(at: point), hit.type != "Widget" || editor.panel == .forms, hit.type != "Link" || editor.panel == .edit {
                editor.selectedAnnotation = hit
                if hit.isMovable {
                    drag = .move(annotation: hit, start: point, before: AnnotationState(hit), resize: false, moved: false)
                }
                if event.clickCount == 2 { editor.showInspector = true; editor.panel = hit.type == "Widget" ? .forms : .comment }
                return
            }
            editor.selectedAnnotation = nil
            super.mouseDown(with: event)
        case .highlight, .underline, .strikeout:
            editor.selectedAnnotation = nil
            super.mouseDown(with: event)
        case .hand:
            if let clip = documentView?.enclosingScrollView?.contentView {
                drag = .pan(start: event.locationInWindow, origin: clip.bounds.origin)
                NSCursor.closedHand.set()
            }
        case .eraser:
            if let hit = page.annotation(at: point), hit.type != "Popup" { editor.remove(hit) }
        case .note:
            editor.addNote(at: point, on: page)
        case .text:
            editor.addTextBox("Text", at: point, on: page)
            editor.tool = .select
        case .stamp, .image:
            editor.placeImage(at: point, on: page)
        case .check, .cross, .dot, .date:
            editor.placeMark(tool, at: point, on: page)
        case .ink:
            drag = .ink(page: page, points: [point])
        default:
            if tool.isDragShape { drag = .shape(page: page, start: point, current: point) }
        }
        overlay.needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        if editDrag != nil { return editMouseDragged(event) }
        guard let drag else { return super.mouseDragged(with: event) }
        switch drag {
        case .shape(let page, let start, _):
            let p = convert(convert(event.locationInWindow, from: nil), to: page)
            self.drag = .shape(page: page, start: start, current: p)
        case .ink(let page, var points):
            points.append(convert(convert(event.locationInWindow, from: nil), to: page))
            self.drag = .ink(page: page, points: points)
        case .move(let a, let start, let before, let resize, _):
            guard let page = a.page else { return }
            let p = convert(convert(event.locationInWindow, from: nil), to: page)
            if resize {
                let top = before.bounds.maxY, left = before.bounds.minX
                var w = max(8, p.x - left), h = max(8, top - p.y)
                if a is ImageStampAnnotation, before.bounds.height > 0 {
                    let ratio = before.bounds.width / before.bounds.height
                    if w / h > ratio { h = w / ratio } else { w = h * ratio }
                }
                a.bounds = CGRect(x: left, y: top - h, width: w, height: h)
            } else {
                a.bounds = before.bounds.offsetBy(dx: p.x - start.x, dy: p.y - start.y)
            }
            annotationsChanged(on: page)
            self.drag = .move(annotation: a, start: start, before: before, resize: resize, moved: true)
        case .pan(let start, let origin):
            guard let clip = documentView?.enclosingScrollView?.contentView else { return }
            let dx = event.locationInWindow.x - start.x
            let dy = event.locationInWindow.y - start.y
            clip.scroll(to: NSPoint(x: origin.x - dx, y: clip.isFlipped ? origin.y + dy : origin.y - dy))
            documentView?.enclosingScrollView?.reflectScrolledClipView(clip)
        }
        overlay.needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        guard let editor else { return super.mouseUp(with: event) }
        if editDrag != nil { return editMouseUp(event) }
        if editor.tool == .editContent { return }
        let finished = drag
        drag = nil
        switch finished {
        case .shape(let page, let start, let current):
            editor.finishShape(editor.tool, page: page, from: start, to: current)
        case .ink(let page, let points):
            editor.addInk(points, on: page)
        case .move(let a, _, let before, let resize, let moved):
            if moved { editor.didModify(a, from: before, name: resize ? "Resize" : "Move") }
        case .pan:
            NSCursor.openHand.set()
        case nil:
            super.mouseUp(with: event)
            if editor.tool.isMarkup, let selection = currentSelection, !(selection.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                editor.markup(selection, tool: editor.tool)
                clearSelection()
            }
        }
        overlay.needsDisplay = true
    }

    override func keyDown(with event: NSEvent) {
        guard let editor else { return super.keyDown(with: event) }
        switch event.keyCode {
        case 51, 117 where editor.editObject != nil:
            if let (page, obj) = editor.editObject { editor.deleteObject(obj, on: page) }
        case 51, 117 where editor.selectedAnnotation != nil: // delete, forward delete
            editor.deleteSelectedAnnotation()
        case 53: // escape
            editor.selectedAnnotation = nil
            editor.editObject = nil
            editor.tool = .select
        case 123 where editor.selectedAnnotation == nil: goToPreviousPage(nil)
        case 124 where editor.selectedAnnotation == nil: goToNextPage(nil)
        default:
            super.keyDown(with: event)
        }
    }

    override func resetCursorRects() {
        super.resetCursorRects()
        guard let tool = editor?.tool else { return }
        switch tool {
        case .select, .highlight, .underline, .strikeout, .editContent: break
        case .hand: addCursorRect(bounds, cursor: .openHand)
        default: addCursorRect(bounds, cursor: .crosshair)
        }
    }

    override func mouseMoved(with event: NSEvent) {
        if isEditingContent { return editMouseMoved(event) }
        guard let tool = editor?.tool, tool != .select, !tool.isMarkup else { return super.mouseMoved(with: event) }
        (tool == .hand ? NSCursor.openHand : NSCursor.crosshair).set()
    }
}

/// Draws selection handles and in-progress shapes above the PDF content.
final class AnnotationOverlay: NSView {
    weak var pdfView: MKPDFView?

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func draw(_ dirtyRect: NSRect) {
        guard let view = pdfView, let editor = view.editor else { return }
        let accent = NSColor.controlAccentColor
        view.drawEditOverlay()

        if let a = editor.selectedAnnotation, let page = a.page, view.document?.index(for: page) != NSNotFound {
            let rect = view.convert(a.bounds, from: page).insetBy(dx: -3, dy: -3)
            let path = NSBezierPath(rect: rect)
            path.lineWidth = 1.5
            path.setLineDash([5, 3], count: 2, phase: 0)
            accent.setStroke()
            path.stroke()
            if a.isResizable {
                let h = view.convert(MKPDFView.handlePoint(a), from: page)
                let handle = NSBezierPath(ovalIn: NSRect(x: h.x - 5, y: h.y - 5, width: 10, height: 10))
                NSColor.white.setFill()
                handle.fill()
                accent.setStroke()
                handle.lineWidth = 2
                handle.stroke()
            }
        }

        let color = editor.color
        let width = max(1, editor.lineWidth * view.scaleFactor)
        switch view.drag {
        case .shape(let page, let start, let current):
            let a = view.convert(start, from: page), b = view.convert(current, from: page)
            let rect = NSRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
            let path: NSBezierPath
            switch editor.tool {
            case .oval: path = NSBezierPath(ovalIn: rect)
            case .line, .arrow:
                path = NSBezierPath()
                path.move(to: a)
                path.line(to: b)
            default: path = NSBezierPath(rect: rect)
            }
            path.lineWidth = width
            switch editor.tool {
            case .redact:
                NSColor.systemRed.withAlphaComponent(0.2).setFill(); path.fill(); NSColor.systemRed.setStroke()
            case .whiteout:
                NSColor.white.setFill(); path.fill(); NSColor.gray.setStroke(); path.lineWidth = 0.5
            case .crop, .link, .textField, .checkbox, .dropdown:
                path.setLineDash([6, 4], count: 2, phase: 0); accent.setStroke(); path.lineWidth = 1.5
            default:
                color.setStroke()
            }
            path.stroke()
        case .ink(let page, let points):
            guard let first = points.first else { break }
            let path = NSBezierPath()
            path.move(to: view.convert(first, from: page))
            for p in points.dropFirst() { path.line(to: view.convert(p, from: page)) }
            path.lineWidth = width
            path.lineCapStyle = .round
            path.lineJoinStyle = .round
            color.setStroke()
            path.stroke()
        default:
            break
        }
    }
}

struct PDFKitView: NSViewRepresentable {
    @ObservedObject var editor: EditorModel
    @ObservedObject var document: PDFFileDocument

    func makeNSView(context: Context) -> MKPDFView {
        let view = MKPDFView()
        view.editor = editor
        view.document = document.pdf
        editor.attach(view)
        return view
    }

    func updateNSView(_ view: MKPDFView, context: Context) {
        if view.document !== document.pdf {
            view.cancelSession()
            view.document = document.pdf
            view.highlightedSelections = nil
        }
        view.applyNightMode(editor.nightMode)
        view.overlay.needsDisplay = true
    }
}
