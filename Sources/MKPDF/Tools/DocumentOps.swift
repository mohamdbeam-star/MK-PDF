import AppKit
import PDFKit
import UniformTypeIdentifiers

extension EditorModel {
    // MARK: - Comments & forms

    func exportCommentSummary() {
        let comments = allComments
        guard !comments.isEmpty else { return Panels.alert("There are no comments to export.") }
        var lines = ["Comment summary — \(documentName)", "Generated \(Date().formatted())", ""]
        for a in comments {
            let page = a.page.map { pdf.index(for: $0) + 1 } ?? 0
            lines.append("Page \(page) · \(a.displayName) · \(a.userName ?? "") · \(a.modificationDate?.formatted() ?? "")")
            if let text = a.contents, !text.isEmpty { lines.append("    \(text.replacingOccurrences(of: "\n", with: "\n    "))") }
        }
        guard let url = Panels.save(name: "\(documentName) comments.txt", type: .plainText) else { return }
        try? lines.joined(separator: "\n").write(to: url, atomically: true, encoding: .utf8)
    }

    /// Burns comments (and optionally form fields) into the page content.
    func flattenAnnotations(includeForms: Bool) {
        transformPages(includeForms ? "Flatten" : "Flatten Comments") { page, _ in
            let burn = page.annotations.filter { $0.isComment || (includeForms && $0.type == "Widget") }
            guard !burn.isEmpty else { return nil }
            for a in burn where a.type == "Widget" { a.backgroundColor = .clear; a.border = nil }
            return PageCompositor.compose(page, burn: burn) { _ in }
        }
    }

    func clearForm() {
        let fields = pdf.pages.flatMap { $0.annotations.filter { $0.type == "Widget" } }
        guard !fields.isEmpty else { return }
        undoManager?.beginUndoGrouping()
        for f in fields {
            modify(f, name: "Clear Form") { a in
                if a.widgetFieldType == .button { a.buttonWidgetState = .offState } else { a.widgetStringValue = "" }
            }
        }
        undoManager?.endUndoGrouping()
    }

    // MARK: - Redaction

    func markSelectionForRedaction() {
        guard let selection = pdfView?.currentSelection, !(selection.string ?? "").isEmpty else {
            return Panels.alert("Select text first", "Use the Select tool to highlight what you want to redact.")
        }
        markForRedaction([selection])
        pdfView?.clearSelection()
    }

    @discardableResult
    func markMatchesForRedaction(_ query: String, wholeWords: Bool) -> Int {
        var matches = pdf.findString(query, withOptions: [.caseInsensitive])
        if wholeWords {
            matches = matches.filter { sel in
                guard let wide = sel.copy() as? PDFSelection else { return true }
                wide.extend(atStart: 1)
                wide.extend(atEnd: 1)
                let s = wide.string ?? ""
                let chars = Array(s)
                let before = chars.first.map { !$0.isLetter && !$0.isNumber } ?? true
                let after = chars.last.map { !$0.isLetter && !$0.isNumber } ?? true
                return before && after
            }
        }
        markForRedaction(matches)
        return matches.count
    }

    private func markForRedaction(_ selections: [PDFSelection]) {
        undoManager?.beginUndoGrouping()
        for sel in selections {
            for line in sel.selectionsByLine() {
                for page in line.pages {
                    add(RedactionMark.make(line.bounds(for: page).insetBy(dx: -1, dy: -1)), to: page, select: false, name: "Mark for Redaction")
                }
            }
        }
        undoManager?.endUndoGrouping()
        undoManager?.setActionName("Mark for Redaction")
    }

    /// Permanently removes content under redaction marks.
    func applyRedactions(dpi: CGFloat, ocr: Bool) {
        guard Panels.confirm("Apply redactions?", message: "Marked content is permanently removed when you save. Pages with marks become images" + (ocr ? " with recognized text." : "."), ok: "Apply", destructive: true) else { return }
        guard let copy = PDFExporter.copy(of: pdf) else { return }
        var work: [(Int, PDFPage, [CGRect])] = []
        for (i, page) in copy.pages.enumerated() {
            let marks = page.annotations.filter(RedactionMark.isMark)
            guard !marks.isEmpty else { continue }
            let rects = marks.map(\.bounds)
            marks.forEach { page.removeAnnotation($0) }
            work.append((i, page, rects))
        }
        guard !work.isEmpty else { return }
        // Text-only redaction first: exact removal of the marked words keeps the page vector and searchable.
        var rasterize: [(Int, PDFPage, [CGRect])] = []
        for (i, page, rects) in work {
            if let clean = ContentEditor.redact(page: page, rects: rects) {
                copy.replacePage(at: i, with: clean)
            } else {
                rasterize.append((i, page, rects))
            }
        }
        if rasterize.isEmpty { return replaceDocument(with: copy, name: "Apply Redactions") }
        for (i, page, rects) in rasterize {
            let flat = PageCompositor.rasterize(page, dpi: dpi, jpegQuality: 0.85) { ctx in
                ctx.setFillColor(.black)
                rects.forEach { ctx.fill($0) }
            }
            if let flat { copy.replacePage(at: i, with: flat) }
        }
        replaceDocument(with: copy, name: "Apply Redactions")
        if ocr { runOCR(pages: rasterize.map(\.0), language: nil, accurate: true, skipTextPages: false) }
    }

    func removeMetadata() {
        let old = pdf.documentAttributes
        pdf.documentAttributes = [:]
        changed()
        undoManager?.registerUndo(withTarget: self) { m in
            m.pdf.documentAttributes = old
            m.changed()
        }
        undoManager?.setActionName("Remove Metadata")
    }

    func setDocumentAttributes(_ attributes: [AnyHashable: Any]) {
        let old = pdf.documentAttributes ?? [:]
        pdf.documentAttributes = attributes
        changed()
        undoManager?.registerUndo(withTarget: self) { $0.setDocumentAttributes(old) }
        undoManager?.setActionName("Document Properties")
    }

    // MARK: - Security

    func setSecurity(_ settings: SecuritySettings?) {
        let old = document.security
        document.security = settings
        changed()
        undoManager?.registerUndo(withTarget: self) { $0.setSecurity(old) }
        undoManager?.setActionName(settings == nil ? "Remove Protection" : "Protect")
    }

    // MARK: - Viewing

    func enterReadMode() {
        displayMode = .singlePage
        showInspector = false
        columnVisibility = .detailOnly
        if let window = pdfView?.window, !window.styleMask.contains(.fullScreen) { window.toggleFullScreen(nil) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { self.zoomToFit() }
    }
}
