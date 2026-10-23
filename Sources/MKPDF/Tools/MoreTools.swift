import AppKit
import PDFKit
import MKPDFCore
import UniformTypeIdentifiers

enum ImageExtractor {
    /// Saves every placed image. JPEGs are written byte-for-byte; others are rendered alone at native resolution.
    static func extract(_ doc: PDFDocument, to folder: URL, name: String, progress: (Double) -> Void = { _ in }) throws -> Int {
        var count = 0
        for (i, page) in doc.pages.enumerated() {
            guard let ref = page.pageRef else { continue }
            let content = PageContent(page: ref)
            for obj in content.objects where obj.kind != .form {
                count += 1
                let base = folder.appendingPathComponent("\(name) p\(i + 1) image \(count)")
                let info = content.imageInfo(for: obj)
                if let jpeg = info?.jpeg {
                    try jpeg.write(to: base.appendingPathExtension("jpg"))
                    continue
                }
                guard let data = content.isolatedPDF(for: obj), let solo = PDFDocument(data: data)?.page(at: 0) else { continue }
                let crop = page.bounds(for: .cropBox)
                let native = info.map { CGFloat($0.width) / max(obj.bounds.width, 1) * 72 } ?? 300
                let dpi = min(max(native, 72), 600)
                guard let full = PageRenderer.image(of: solo, dpi: dpi, annotations: false) else { continue }
                let s = dpi / 72
                let r = obj.bounds.intersection(crop)
                let pixel = CGRect(x: (r.minX - crop.minX) * s, y: (crop.maxY - r.maxY) * s, width: r.width * s, height: r.height * s).integral
                if let cut = full.cropping(to: pixel), let png = PageRenderer.encode(cut, type: .png) {
                    try png.write(to: base.appendingPathExtension("png"))
                }
            }
            progress(Double(i + 1) / Double(max(doc.pageCount, 1)))
        }
        return count
    }
}

extension EditorModel {
    // MARK: - Images

    /// Saves every image placed in the document. JPEGs are written byte-for-byte; others are rendered on
    /// their own at their native resolution.
    func extractAllImages() {
        guard let folder = Panels.folder(title: "Choose a folder for the extracted images") else { return }
        guard let copy = PDFExporter.copy(of: pdf) else { return }
        let name = documentName
        run("Extracting images…") { progress -> Int in
            try ImageExtractor.extract(copy, to: folder, name: name, progress: progress)
        } then: { count in
            if count == 0 { return Panels.alert("No images found", "This document has no embedded images.") }
            Notifier.taskFinished("Extracted \(count) images", detail: name)
            NSWorkspace.shared.activateFileViewerSelecting([folder])
        }
    }

    func removeAllImages() {
        guard Panels.confirm("Remove all images?", message: "Photos, logos and scanned images are deleted from every page. Text stays.", ok: "Remove", destructive: true) else { return }
        transformPages("Remove Images") { page, _ in
            guard let ref = page.pageRef, !PageContent(page: ref).objects.filter({ $0.kind != .form }).isEmpty else { return nil }
            let result = ContentEditor.rewrite(page, edit: { content in
                while let obj = content.objects.first(where: { $0.kind != .form }) { content.removeObject(obj) }
            })
            for a in page.annotations { if let c = a.copy() as? PDFAnnotation { result?.addAnnotation(c) } }
            return result
        }
    }

    // MARK: - Repair

    /// Rebuilds every page from Core Graphics' tolerant parser, which recovers many damaged files.
    func repairDocument() {
        let original = pdf
        run("Repairing…") { progress -> (PDFDocument, Int) in
            let data = original.dataRepresentation() ?? Data()
            let doc = PDFDocument()
            var fixed = 0
            if let cg = CGPDFDocument(CGDataProvider(data: data as CFData)!) {
                for n in 1...max(cg.numberOfPages, 1) {
                    guard let page = cg.page(at: n) else { continue }
                    let content = PageContent(page: page)
                    if let d = content.pdfData(), let rebuilt = PDFDocument(data: d)?.page(at: 0) {
                        rebuilt.setBounds(page.getBoxRect(.cropBox), for: .cropBox)
                        rebuilt.rotation = Int(page.rotationAngle)
                        doc.insert(rebuilt, at: doc.pageCount)
                        fixed += 1
                    }
                    progress(Double(n) / Double(cg.numberOfPages))
                }
            }
            return (doc, fixed)
        } then: { result in
            let (doc, fixed) = result
            guard fixed > 0 else { return Panels.alert("Couldn't repair this file") }
            // Keep annotations from the readable original.
            for (i, page) in doc.pages.enumerated() {
                original.page(at: i)?.annotations.forEach { if let c = $0.copy() as? PDFAnnotation { page.addAnnotation(c) } }
            }
            doc.documentAttributes = original.documentAttributes
            self.replaceDocument(with: doc, name: "Repair")
            Panels.alert("Repaired \(fixed) pages", "Every page was rebuilt with a clean structure. Save to keep the repaired file.")
        }
    }

    // MARK: - Place on many pages

    enum PlacementPages: String, CaseIterable, Identifiable {
        case all = "Every page", allButLast = "Every page except the last", lastOnly = "Last page only", range = "Page range…"
        var id: String { rawValue }
    }

    /// Copies the selected signature, stamp or image to the same spot on other pages.
    func place(_ annotation: PDFAnnotation, on pages: PlacementPages) {
        guard let source = annotation.page else { return }
        let sourceIndex = pdf.index(for: source)
        var targets: [Int]
        switch pages {
        case .all: targets = Array(0..<pageCount)
        case .allButLast: targets = Array(0..<max(pageCount - 1, 1))
        case .lastOnly: targets = [pageCount - 1]
        case .range:
            guard let text = Panels.prompt("Place on pages", message: "Pages (for example 1-3, 6).", value: "1-\(pageCount)"),
                  let parsed = PageRanges.parse(text, pageCount: pageCount) else { return }
            targets = parsed
        }
        undoManager?.beginUndoGrouping()
        if pages == .lastOnly {
            // Move it to the last page.
            if sourceIndex != pageCount - 1, let last = pdf.page(at: pageCount - 1), let copy = annotation.copy() as? PDFAnnotation {
                remove(annotation, name: "Place on Pages")
                add(copy, to: last, select: false, name: "Place on Pages")
            }
        } else {
            for i in Set(targets) where i != sourceIndex {
                guard let page = pdf.page(at: i), let copy = annotation.copy() as? PDFAnnotation else { continue }
                add(copy, to: page, select: false, name: "Place on Pages")
            }
        }
        undoManager?.endUndoGrouping()
        undoManager?.setActionName("Place on Pages")
    }

    // MARK: - Office export with optional OCR

    /// Hands `use` a copy of the document, running OCR first on pages with no text when `ocr` is set.
    func withSearchableCopy(ocr: Bool, _ use: @escaping (PDFDocument) -> Void) {
        guard let copy = PDFExporter.copy(of: pdf) else { return }
        let scanned = copy.pages.enumerated().filter { ($0.element.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.map(\.offset)
        guard ocr, !scanned.isEmpty else { return use(copy) }
        run("Recognizing text…") { progress in
            var out: [(Int, [OCR.Line])] = []
            for (n, i) in scanned.enumerated() {
                if let page = copy.page(at: i) { out.append((i, try OCR.recognize(page, language: nil, accurate: true))) }
                progress(Double(n + 1) / Double(scanned.count))
            }
            return out
        } then: { results in
            for (i, lines) in results where !lines.isEmpty {
                if let page = copy.page(at: i), let composed = PageCompositor.compose(page, overlay: { OCR.drawInvisibleText(lines, in: $0) }) {
                    copy.replacePage(at: i, with: composed)
                }
            }
            use(copy)
        }
    }

    func exportOffice(_ format: ExportFormat, ocr: Bool) {
        let name = documentName
        let ext = format.fileExtension
        guard let url = Panels.save(name: "\(name).\(ext)", type: format.type) else { return }
        withSearchableCopy(ocr: ocr && format != .powerpoint && format != .html) { doc in
            self.run("Converting…") { progress -> Data in
                try format.render(doc, title: name, progress: progress)
            } then: { data in
                do {
                    try data.write(to: url)
                    Notifier.taskFinished("Converted to \(ext.uppercased())", detail: url.lastPathComponent)
                    NSWorkspace.shared.activateFileViewerSelecting([url])
                } catch { Panels.alert("Export failed", error.localizedDescription) }
            }
        }
    }
}
