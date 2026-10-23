import AppKit
import PDFKit

/// A placed picture (signature, initials, stamp or image). Shown live while editing and burned into
/// the page when the document is saved, since PDFKit can't write a custom appearance.
final class ImageStampAnnotation: PDFAnnotation {
    let image: NSImage
    let kind: String

    init(image: NSImage, bounds: CGRect, kind: String = "Image") {
        self.image = image
        self.kind = kind
        super.init(bounds: bounds, forType: .stamp, withProperties: nil)
    }

    required init?(coder: NSCoder) { nil }

    override func copy(with zone: NSZone? = nil) -> Any {
        let c = ImageStampAnnotation(image: image, bounds: bounds, kind: kind)
        c.userName = userName
        return c
    }

    override func draw(with box: PDFDisplayBox, in context: CGContext) {
        drawImage(in: context)
    }

    /// Draws through AppKit so vector images (typed signatures, stamps) stay sharp in the saved PDF.
    func drawImage(in ctx: CGContext) {
        ctx.saveGState()
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
        // Keep the image upright on rotated pages.
        if let page, page.normalizedRotation != 0 {
            ctx.translateBy(x: bounds.midX, y: bounds.midY)
            ctx.rotate(by: -CGFloat(page.normalizedRotation) * .pi / 180)
            let size = page.normalizedRotation % 180 == 0 ? bounds.size : CGSize(width: bounds.height, height: bounds.width)
            image.draw(in: CGRect(x: -size.width / 2, y: -size.height / 2, width: size.width, height: size.height))
        } else {
            image.draw(in: bounds)
        }
        NSGraphicsContext.restoreGraphicsState()
        ctx.restoreGState()
    }
}

extension NSImage {
    /// PNG rendered at `scale`× its point size, keeping the point size in the file's DPI.
    func pngData(scale: CGFloat = 3) -> Data? {
        let w = max(1, Int(size.width * scale)), h = max(1, Int(size.height * scale))
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8,
                                         samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                         bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        rep.size = size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        draw(in: NSRect(origin: .zero, size: size))
        NSGraphicsContext.restoreGraphicsState()
        return rep.representation(using: .png, properties: [:])
    }
}

/// Marks an area for redaction. Stored as a square annotation tagged by name so marks survive saving.
enum RedactionMark {
    static let tag = "MKPDF-Redaction"

    static func make(_ rect: CGRect) -> PDFAnnotation {
        let a = PDFAnnotation(bounds: rect, forType: .square, withProperties: nil)
        a.color = .systemRed
        a.interiorColor = NSColor.systemRed.withAlphaComponent(0.18)
        let border = PDFBorder()
        border.lineWidth = 1.5
        a.border = border
        a.setValue(tag, forAnnotationKey: .name)
        a.contents = "Redaction mark"
        return a
    }

    /// PDFKit doesn't write the name key, so saved marks are recognised by their comment too.
    static func isMark(_ a: PDFAnnotation) -> Bool {
        (a.value(forAnnotationKey: .name) as? String) == tag || (a.type == "Square" && a.contents == "Redaction mark")
    }
}

/// Snapshot of the editable properties of an annotation, for undo.
struct AnnotationState {
    var bounds: CGRect
    var color: NSColor
    var interiorColor: NSColor?
    var contents: String?
    var font: NSFont?
    var fontColor: NSColor?
    var lineWidth: CGFloat
    var startPoint: CGPoint
    var endPoint: CGPoint
    var stringValue: String?
    var buttonState: PDFWidgetCellState
    var fieldName: String?

    init(_ a: PDFAnnotation) {
        bounds = a.bounds
        color = a.color
        interiorColor = a.interiorColor
        contents = a.contents
        font = a.font
        fontColor = a.fontColor
        lineWidth = a.border?.lineWidth ?? 1
        startPoint = a.startPoint
        endPoint = a.endPoint
        stringValue = a.widgetStringValue
        buttonState = a.buttonWidgetState
        fieldName = a.fieldName
    }

    func apply(to a: PDFAnnotation) {
        a.bounds = bounds
        a.color = color
        a.interiorColor = interiorColor
        a.contents = contents
        if let font { a.font = font }
        if let fontColor { a.fontColor = fontColor }
        if let border = a.border { border.lineWidth = lineWidth; a.border = border }
        if a.type == "Line" { a.startPoint = startPoint; a.endPoint = endPoint }
        if a.type == "Widget" {
            if a.widgetFieldType == .button { a.buttonWidgetState = buttonState } else { a.widgetStringValue = stringValue }
            a.fieldName = fieldName
        }
    }
}

extension PDFAnnotation {
    /// Comments and markup the user made (not form fields, links or redaction marks).
    var isComment: Bool {
        guard let type else { return false }
        return !["Widget", "Link", "Popup"].contains(type) && !RedactionMark.isMark(self)
    }

    var isMovable: Bool {
        guard let type else { return false }
        return !["Highlight", "Underline", "StrikeOut", "Squiggly", "Link", "Popup"].contains(type)
    }

    var isResizable: Bool {
        guard let type else { return false }
        return ["FreeText", "Square", "Circle", "Stamp", "Widget"].contains(type) || self is ImageStampAnnotation
    }

    var displayName: String {
        if let s = self as? ImageStampAnnotation { return s.kind }
        if RedactionMark.isMark(self) { return "Redaction" }
        switch type ?? "" {
        case "Text": return "Note"
        case "FreeText": return "Text Box"
        case "Ink": return "Drawing"
        case "Square": return "Rectangle"
        case "Circle": return "Oval"
        case "StrikeOut": return "Strikethrough"
        case "Widget": return "Form Field"
        case let t: return t
        }
    }

    var symbolName: String {
        if self is ImageStampAnnotation { return "signature" }
        switch type ?? "" {
        case "Highlight": return "highlighter"
        case "Underline": return "underline"
        case "StrikeOut": return "strikethrough"
        case "Text": return "note.text"
        case "FreeText": return "textformat"
        case "Ink": return "scribble"
        case "Square": return "rectangle"
        case "Circle": return "circle"
        case "Line": return "line.diagonal.arrow"
        case "Widget": return "rectangle.and.pencil.and.ellipsis"
        default: return "bubble.left"
        }
    }
}

/// Renders the rubber stamps offered in the Comment tools.
enum StampFactory {
    struct Stamp: Hashable {
        let title: String
        let color: NSColor
    }

    static let stamps: [Stamp] = [
        Stamp(title: "APPROVED", color: .systemGreen),
        Stamp(title: "NOT APPROVED", color: .systemRed),
        Stamp(title: "DRAFT", color: .systemBlue),
        Stamp(title: "FINAL", color: .systemGreen),
        Stamp(title: "CONFIDENTIAL", color: .systemRed),
        Stamp(title: "FOR COMMENT", color: .systemBlue),
        Stamp(title: "REVIEWED", color: .systemIndigo),
        Stamp(title: "RECEIVED", color: .systemTeal),
        Stamp(title: "VOID", color: .systemRed),
        Stamp(title: "PAID", color: .systemGreen),
        Stamp(title: "SIGN HERE", color: .systemOrange),
        Stamp(title: "COPY", color: .systemGray),
    ]

    /// A stamp image, with the author and date underneath when `dynamic` is set.
    static func image(_ stamp: Stamp, author: String?, dynamic: Bool) -> NSImage {
        let title = NSAttributedString(string: stamp.title, attributes: [
            .font: NSFont.systemFont(ofSize: 44, weight: .black),
            .foregroundColor: stamp.color,
            .kern: 2,
        ])
        let detail: NSAttributedString? = dynamic ? NSAttributedString(
            string: [author, Date().formatted(date: .abbreviated, time: .shortened)].compactMap { $0 }.joined(separator: " · "),
            attributes: [.font: NSFont.systemFont(ofSize: 18, weight: .semibold), .foregroundColor: stamp.color]
        ) : nil
        let t = title.size()
        let d = detail?.size() ?? .zero
        let size = CGSize(width: max(t.width, d.width) + 48, height: t.height + (detail == nil ? 0 : d.height + 4) + 24)
        return NSImage(size: size, flipped: false) { rect in
            let frame = NSBezierPath(roundedRect: rect.insetBy(dx: 4, dy: 4), xRadius: 12, yRadius: 12)
            frame.lineWidth = 5
            stamp.color.withAlphaComponent(0.06).setFill()
            frame.fill()
            stamp.color.setStroke()
            frame.stroke()
            let top = rect.height - 12 - t.height
            title.draw(at: CGPoint(x: (rect.width - t.width) / 2, y: top))
            detail?.draw(at: CGPoint(x: (rect.width - d.width) / 2, y: 12))
            return true
        }
    }
}
