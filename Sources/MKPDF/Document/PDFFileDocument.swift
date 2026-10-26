import SwiftUI
import PDFKit
import MKPDFCore
import UniformTypeIdentifiers

/// Passwords and permissions applied when the document is written.
struct SecuritySettings: Equatable {
    var userPassword: String?          // required to open the file
    var ownerPassword: String          // required to change permissions
    var permissions: Permissions

    /// Bits of the PDF permission flags (PDFKit exposes them as a plain enum).
    struct Permissions: OptionSet {
        let rawValue: UInt
        static let lowQualityPrinting = Permissions(rawValue: 1 << 0)
        static let highQualityPrinting = Permissions(rawValue: 1 << 1)
        static let documentChanges = Permissions(rawValue: 1 << 2)
        static let documentAssembly = Permissions(rawValue: 1 << 3)
        static let contentCopying = Permissions(rawValue: 1 << 4)
        static let contentAccessibility = Permissions(rawValue: 1 << 5)
        static let commenting = Permissions(rawValue: 1 << 6)
        static let formFieldEntry = Permissions(rawValue: 1 << 7)
    }

    static let allPermissions = Permissions(rawValue: 0xFF)
}

final class PDFFileDocument: ReferenceFileDocument {
    static var readableContentTypes: [UTType] { [.pdf] }
    static var writableContentTypes: [UTType] { [.pdf] }

    @Published var pdf: PDFDocument
    /// Bumped on every edit so views that read the PDF re-render.
    @Published var revision = 0
    @Published var security: SecuritySettings?

    init() {
        if let pending = DocumentLauncher.pending {
            DocumentLauncher.pending = nil
            pdf = pending
        } else {
            pdf = PDFDocument()
            pdf.insert(PageFactory.blank(size: PageFactory.letter), at: 0)
        }
    }

    required init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents, let doc = PDFDocument(data: data) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        pdf = doc
    }

    func snapshot(contentType: UTType) throws -> Data {
        try PDFExporter.data(for: pdf, security: security)
    }

    func fileWrapper(snapshot: Data, configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: snapshot)
    }
}

enum PDFExporter {
    struct ExportError: LocalizedError {
        var errorDescription: String? { "The PDF couldn't be written." }
    }

    /// Serialises the document, burning placed images (signatures, stamps, pictures) into their pages.
    static func data(for doc: PDFDocument, security: SecuritySettings? = nil, extraOptions: [PDFDocumentWriteOption: Any] = [:]) throws -> Data {
        var options: [PDFDocumentWriteOption: Any] = extraOptions
        if let security {
            options[.ownerPasswordOption] = security.ownerPassword
            if let user = security.userPassword, !user.isEmpty { options[.userPasswordOption] = user }
            options[.accessPermissionsOption] = NSNumber(value: security.permissions.rawValue)
        }
        var output = flattenedImages(doc)
        if let single = singleSource(output) { output = single }
        guard let data = output.dataRepresentation(options: options) else { throw ExportError() }
        return data
    }

    /// PDFKit re-draws every page of a document that holds pages from other PDFs (edited, inserted, OCR'd or
    /// stamped pages) when it saves it. Re-drawing turns Type 3 fonts, which Chromium-based browsers use for
    /// "Save as PDF", into outlines, so the text is no longer text. For such a document, the pages are written
    /// from their own untouched content, with the annotations (comments, form fields, links) PDFKit wrote and
    /// the catalog (bookmarks, forms), giving a single-source document PDFKit then saves as it is.
    static func singleSource(_ doc: PDFDocument) -> PDFDocument? {
        // Pages from other PDFs don't belong to this document's own file.
        let own = doc.documentRef
        let mixed = (0..<doc.pageCount).contains { doc.page(at: $0)?.pageRef?.document !== own }
        guard mixed, let rendered = doc.dataRepresentation(),
              let provider = CGDataProvider(data: rendered as CFData), let cg = CGPDFDocument(provider), cg.numberOfPages == doc.pageCount else { return nil }
        var pages: [PDFWriter.DocumentPage] = []
        for i in 0..<doc.pageCount {
            guard let page = doc.page(at: i), let source = page.pageRef, let out = cg.page(at: i + 1) else { return nil }
            var annots: CGPDFArrayRef?
            if let d = out.dictionary { CGPDFDictionaryGetArray(d, "Annots", &annots) }
            let crop = page.bounds(for: .cropBox)
            pages.append(PDFWriter.DocumentPage(source: source, annotations: annots, rotation: page.rotation,
                                                cropBox: crop == source.getBoxRect(.cropBox) ? nil : crop,
                                                aliases: out.dictionary.map { [$0] } ?? []))
        }
        guard let data = PDFWriter.document(pages: pages, catalog: cg.catalog, info: cg.info),
              let single = PDFDocument(data: data), single.pageCount == doc.pageCount else { return nil }
        return single
    }

    /// A standalone copy of the document with placed images burned in.
    static func copy(of doc: PDFDocument) -> PDFDocument? {
        guard let data = try? data(for: doc) else { return nil }
        return PDFDocument(data: data)
    }

    private static func flattenedImages(_ doc: PDFDocument) -> PDFDocument {
        var stamps: [(page: PDFPage, annotation: ImageStampAnnotation)] = []
        for i in 0..<doc.pageCount {
            guard let page = doc.page(at: i) else { continue }
            for case let a as ImageStampAnnotation in page.annotations { stamps.append((page, a)) }
        }
        guard !stamps.isEmpty else { return doc }

        // Serialise without the image annotations (PDFKit can't write their appearance), then redraw
        // the affected pages with the images drawn into the page content.
        for s in stamps { s.page.removeAnnotation(s.annotation) }
        let data = doc.dataRepresentation()
        for s in stamps { s.page.addAnnotation(s.annotation) }
        guard let data, let copy = PDFDocument(data: data) else { return doc }

        for i in 0..<doc.pageCount {
            guard let original = doc.page(at: i) else { continue }
            let images = stamps.filter { $0.page === original }.map(\.annotation)
            guard !images.isEmpty, let page = copy.page(at: i),
                  let flat = PageCompositor.compose(page, overlay: { ctx in images.forEach { $0.drawImage(in: ctx) } })
            else { continue }
            copy.replacePage(at: i, with: flat)
        }
        return copy
    }
}
