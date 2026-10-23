import AppKit
import PDFKit
import MKPDFCore

/// Style of the text being edited in place; the inspector changes it live.
struct EditStyle: Equatable {
    var font: NSFont
    var color: NSColor
    var alignment: NSTextAlignment
}

/// The text view shown over a paragraph while it's being edited.
final class InlineTextView: NSTextView {
    var onCommit: () -> Void = {}
    var onCancel: () -> Void = {}
    var onChange: () -> Void = {}
    /// Typing undo stays inside the editor; the document gets one undo step when the edit is applied.
    private let localUndo = UndoManager()
    override var undoManager: UndoManager? { localUndo }

    override func didChangeText() {
        super.didChangeText()
        onChange()
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { return onCancel() }
        if event.keyCode == 36, event.modifierFlags.contains(.command) { return onCommit() }
        super.keyDown(with: event)
    }
}

/// Per-view state for "Edit Text & Images".
final class ContentEditState {
    final class Entry {
        let blocks: [TextBlock]
        let objects: [GraphicObject]
        init(blocks: [TextBlock], objects: [GraphicObject]) { self.blocks = blocks; self.objects = objects }
    }

    struct Session {
        let page: PDFPage
        let block: TextBlock?
        let origin: CGPoint      // first baseline start, page space
        let textView: InlineTextView
    }

    let cache = NSMapTable<PDFPage, Entry>.weakToStrongObjects()
    var hovered: (page: PDFPage, rect: CGRect)?
    var session: Session?

    func entry(for page: PDFPage) -> Entry {
        if let e = cache.object(forKey: page) { return e }
        let e = Entry(blocks: ContentEditor.blocks(on: page), objects: ContentEditor.objects(on: page))
        cache.setObject(e, forKey: page)
        return e
    }
}

extension MKPDFView {
    var isEditingContent: Bool { editor?.tool == .editContent }

    func contentBlock(at point: CGPoint, on page: PDFPage) -> TextBlock? {
        contentEdit.entry(for: page).blocks.first { $0.rect.insetBy(dx: -2, dy: -2).contains(point) }
    }

    func contentObject(at point: CGPoint, on page: PDFPage) -> GraphicObject? {
        contentEdit.entry(for: page).objects.filter { $0.bounds.contains(point) }
            .min { $0.bounds.width * $0.bounds.height < $1.bounds.width * $1.bounds.height }
    }

    // MARK: - Mouse

    func editMouseDown(_ event: NSEvent, page: PDFPage, point: CGPoint) {
        guard let editor else { return }
        let viewPoint = convert(event.locationInWindow, from: nil)
        if let s = contentEdit.session {
            // Clicks that land on the inline editor belong to it (it can sit under PDFKit's own subviews).
            if s.textView.frame.contains(viewPoint) {
                window?.makeFirstResponder(s.textView)
                return s.textView.mouseDown(with: event)
            }
            commitSession()
        }

        if let (selPage, obj) = editor.editObject, selPage === page {
            let handle = convert(CGPoint(x: obj.bounds.maxX, y: obj.bounds.minY), from: page)
            if abs(handle.x - viewPoint.x) < 9 && abs(handle.y - viewPoint.y) < 9 {
                editDrag = .object(page: page, object: obj, start: point, current: point, resize: true)
                return
            }
        }
        if let block = contentBlock(at: point, on: page) {
            editor.editObject = nil
            editDrag = .block(page: page, block: block, start: point, current: point)
            return
        }
        if let obj = contentObject(at: point, on: page) {
            editor.editObject = (page, obj)
            editDrag = .object(page: page, object: obj, start: point, current: point, resize: false)
            return
        }
        editor.editObject = nil
        if event.clickCount == 2 || editor.addingContentText {
            editor.addingContentText = false
            beginSession(page: page, block: nil, origin: point)
        }
    }

    func editMouseDragged(_ event: NSEvent) {
        guard let drag = editDrag else { return }
        let viewPoint = convert(event.locationInWindow, from: nil)
        switch drag {
        case .block(let page, let block, let start, _):
            editDrag = .block(page: page, block: block, start: start, current: convert(viewPoint, to: page))
        case .object(let page, let obj, let start, _, let resize):
            editDrag = .object(page: page, object: obj, start: start, current: convert(viewPoint, to: page), resize: resize)
        }
        overlay.needsDisplay = true
    }

    func editMouseUp(_ event: NSEvent) {
        guard let editor, let drag = editDrag else { return }
        editDrag = nil
        switch drag {
        case .block(let page, let block, let start, let current):
            let dx = current.x - start.x, dy = current.y - start.y
            contentEdit.hovered = nil
            if hypot(dx, dy) < 3 {
                beginSession(page: page, block: block, origin: CGPoint(x: block.rect.minX, y: block.firstBaseline))
            } else {
                editor.commitTextEdit(page: page, original: block, text: block.text, font: block.font, color: block.color,
                                      alignment: block.alignment, at: CGPoint(x: block.rect.minX + dx, y: block.firstBaseline + dy),
                                      width: block.isMultiline ? block.rect.width + 2 : nil, box: block.rect.width)
            }
        case .object(let page, let obj, _, _, _):
            contentEdit.hovered = nil
            let rect = Self.draggedRect(drag)
            if !rect.equalTo(obj.bounds) {
                editor.moveObject(obj, on: page, to: rect)
                editor.editObject = nil
            }
        }
        overlay.needsDisplay = true
    }

    static func draggedRect(_ drag: EditDrag) -> CGRect {
        switch drag {
        case .block(_, let block, let start, let current):
            return block.rect.offsetBy(dx: current.x - start.x, dy: current.y - start.y)
        case .object(_, let obj, let start, let current, let resize):
            let b = obj.bounds
            guard resize else { return b.offsetBy(dx: current.x - start.x, dy: current.y - start.y) }
            // Resize from the bottom-right corner, keeping proportions.
            let w = max(8, current.x - b.minX)
            let h = b.width > 0 ? w * b.height / b.width : w
            return CGRect(x: b.minX, y: b.maxY - h, width: w, height: h)
        }
    }

    func editMouseMoved(_ event: NSEvent) {
        let viewPoint = convert(event.locationInWindow, from: nil)
        var hover: (PDFPage, CGRect)?
        if let page = page(for: viewPoint, nearest: false) {
            let p = convert(viewPoint, to: page)
            if let b = contentBlock(at: p, on: page) { hover = (page, b.rect) }
            else if let o = contentObject(at: p, on: page) { hover = (page, o.bounds) }
            (hover == nil ? NSCursor.arrow : contentBlock(at: p, on: page) != nil ? NSCursor.iBeam : NSCursor.openHand).set()
        }
        if hover?.1 != contentEdit.hovered?.rect || hover?.0 !== contentEdit.hovered?.page {
            contentEdit.hovered = hover.map { (page: $0.0, rect: $0.1) }
            overlay.needsDisplay = true
        }
    }

    // MARK: - Inline text session

    func beginSession(page: PDFPage, block: TextBlock?, origin: CGPoint) {
        guard let editor else { return }
        let size = block?.font.pointSize ?? max(editor.fontSize, 6)
        let style = EditStyle(font: block?.font ?? NSFont(name: "Helvetica", size: size) ?? .systemFont(ofSize: size),
                              color: block?.color ?? .black, alignment: block?.alignment ?? .left)
        let tv = InlineTextView(frame: .zero)
        tv.string = block?.text ?? ""
        tv.isRichText = false
        tv.allowsUndo = true
        tv.drawsBackground = true
        tv.backgroundColor = .white
        tv.textContainerInset = .zero
        tv.textContainer?.lineFragmentPadding = 0
        tv.isVerticallyResizable = true
        tv.wantsLayer = true
        tv.layer?.borderColor = NSColor.controlAccentColor.cgColor
        tv.layer?.borderWidth = 1
        tv.onCommit = { [weak self] in self?.commitSession() }
        tv.onCancel = { [weak self] in self?.cancelSession() }
        tv.onChange = { [weak self] in self?.layoutSession() }
        addSubview(tv, positioned: .below, relativeTo: overlay)
        contentEdit.session = ContentEditState.Session(page: page, block: block, origin: origin, textView: tv)
        editor.editStyle = style
        layoutSession()
        window?.makeFirstResponder(tv)
        tv.setSelectedRange(NSRange(location: (tv.string as NSString).length, length: 0))
        overlay.needsDisplay = true
    }

    /// Positions and styles the inline editor to sit exactly over the paragraph at the current zoom.
    func layoutSession() {
        guard let s = contentEdit.session, let style = editor?.editStyle else { return }
        let scale = scaleFactor
        let tv = s.textView
        let font = style.font.withSize(style.font.pointSize * scale)
        let pitch = (s.block?.pitch ?? style.font.pointSize * 1.2) * scale
        let para = NSMutableParagraphStyle()
        para.minimumLineHeight = pitch
        para.maximumLineHeight = pitch
        para.alignment = style.alignment
        tv.font = font
        tv.textColor = style.color
        tv.defaultParagraphStyle = para
        tv.typingAttributes = [.font: font, .foregroundColor: style.color, .paragraphStyle: para]
        tv.textStorage?.setAttributes(tv.typingAttributes, range: NSRange(location: 0, length: tv.textStorage?.length ?? 0))

        let multiline = s.block?.isMultiline ?? false
        let pageWidth = s.block.map { $0.rect.width } ?? 200
        let width: CGFloat
        if multiline {
            width = (pageWidth + 2) * scale
            tv.isHorizontallyResizable = false
            tv.textContainer?.widthTracksTextView = true
            tv.textContainer?.containerSize = NSSize(width: width, height: .greatestFiniteMagnitude)
        } else {
            tv.isHorizontallyResizable = true
            tv.textContainer?.widthTracksTextView = false
            tv.textContainer?.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
            tv.layoutManager?.ensureLayout(for: tv.textContainer!)
            let used = tv.layoutManager?.usedRect(for: tv.textContainer!).width ?? 0
            width = max(used + font.pointSize, pageWidth * scale, 40)
        }
        tv.layoutManager?.ensureLayout(for: tv.textContainer!)
        let lines = max(1, Int(((tv.layoutManager?.usedRect(for: tv.textContainer!).height ?? pitch) / pitch).rounded(.up)))
        let height = CGFloat(lines) * pitch
        let baseline = convert(s.origin, from: s.page)
        // Baseline sits about a descender above the bottom of the first line.
        let firstLineTop = baseline.y + pitch + font.descender - (pitch - font.ascender + font.descender) / 2
        var x = baseline.x
        if !multiline, let block = s.block, style.alignment == .right { x = convert(CGPoint(x: block.rect.maxX, y: 0), from: s.page).x - width }
        tv.frame = NSRect(x: x - 2, y: firstLineTop - height, width: width + 4, height: height)
        tv.textContainerInset = NSSize(width: 2, height: 0)
    }

    func commitSession() {
        guard let s = contentEdit.session, let editor, let style = editor.editStyle else { return }
        let text = s.textView.string
        endSession()
        let changed = s.block.map { b in text != b.text || style.font != b.font || style.color != b.color || style.alignment != b.alignment } ?? true
        guard changed, !(s.block == nil && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) else { return }
        let multiline = s.block?.isMultiline ?? false
        editor.commitTextEdit(page: s.page, original: s.block, text: text, font: style.font, color: style.color,
                              alignment: style.alignment, at: s.origin,
                              width: multiline ? (s.block!.rect.width + 2) : nil, box: s.block?.rect.width)
    }

    func cancelSession() {
        endSession()
    }

    private func endSession() {
        guard let s = contentEdit.session else { return }
        s.textView.removeFromSuperview()
        contentEdit.session = nil
        editor?.editStyle = nil
        window?.makeFirstResponder(self)
        overlay.needsDisplay = true
    }

    // MARK: - Drawing

    func drawEditOverlay() {
        guard isEditingContent else { return }
        let accent = NSColor.controlAccentColor
        for page in visiblePages {
            let entry = contentEdit.entry(for: page)
            NSColor.secondaryLabelColor.withAlphaComponent(0.35).setStroke()
            for b in entry.blocks {
                let path = NSBezierPath(rect: convert(b.rect, from: page).insetBy(dx: -2, dy: -2))
                path.lineWidth = 0.5
                path.stroke()
            }
            NSColor.systemPurple.withAlphaComponent(0.45).setStroke()
            for o in entry.objects {
                let path = NSBezierPath(rect: convert(o.bounds, from: page))
                path.lineWidth = 0.75
                path.setLineDash([4, 3], count: 2, phase: 0)
                path.stroke()
            }
        }
        if let h = contentEdit.hovered, contentEdit.session == nil, editDrag == nil {
            let path = NSBezierPath(rect: convert(h.rect, from: h.page).insetBy(dx: -2, dy: -2))
            path.lineWidth = 1.5
            accent.setStroke()
            path.stroke()
        }
        if let (page, obj) = editor?.editObject, editDrag == nil {
            let r = convert(obj.bounds, from: page)
            let path = NSBezierPath(rect: r)
            path.lineWidth = 2
            accent.setStroke()
            path.stroke()
            let handle = NSBezierPath(ovalIn: NSRect(x: r.maxX - 5, y: r.minY - 5, width: 10, height: 10))
            NSColor.white.setFill()
            handle.fill()
            handle.stroke()
        }
        if let drag = editDrag {
            let page: PDFPage
            switch drag {
            case .block(let p, _, _, _), .object(let p, _, _, _, _): page = p
            }
            let path = NSBezierPath(rect: convert(Self.draggedRect(drag), from: page))
            path.lineWidth = 1.5
            path.setLineDash([6, 3], count: 2, phase: 0)
            accent.setStroke()
            path.stroke()
            accent.withAlphaComponent(0.08).setFill()
            path.fill()
        }
    }
}

