import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// Thin wrappers over the standard open/save panels and alerts.
enum Panels {
    static let imageTypes: [UTType] = [.png, .jpeg, .tiff, .heic, .gif, .bmp, .image]
    static let documentTypes: [UTType] = [.plainText, .rtf, .rtfd, .html,
                                          UTType("org.openxmlformats.wordprocessingml.document") ?? .data,
                                          UTType("com.microsoft.word.doc") ?? .data,
                                          UTType("org.oasis-open.opendocument.text") ?? .data]

    static func open(_ types: [UTType], multiple: Bool = false, title: String? = nil) -> [URL] {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = types
        panel.allowsMultipleSelection = multiple
        panel.canChooseDirectories = false
        if let title { panel.message = title }
        return panel.runModal() == .OK ? panel.urls : []
    }

    static func save(name: String, type: UTType, title: String? = nil) -> URL? {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [type]
        panel.nameFieldStringValue = name
        panel.canCreateDirectories = true
        if let title { panel.message = title }
        return panel.runModal() == .OK ? panel.url : nil
    }

    static func folder(title: String) -> URL? {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.prompt = "Choose"
        panel.message = title
        return panel.runModal() == .OK ? panel.url : nil
    }

    static func prompt(_ title: String, message: String = "", value: String = "", placeholder: String = "", secure: Bool = false) -> String? {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        let field: NSTextField = secure ? NSSecureTextField() : NSTextField()
        field.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
        field.stringValue = value
        field.placeholderString = placeholder
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        return alert.runModal() == .alertFirstButtonReturn ? field.stringValue : nil
    }

    static func alert(_ title: String, _ message: String = "") {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.runModal()
    }

    static func confirm(_ title: String, message: String = "", ok: String = "OK", destructive: Bool = false) -> Bool {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        let button = alert.addButton(withTitle: ok)
        button.hasDestructiveAction = destructive
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }
}

/// Parses page ranges such as "1-3, 5, 8-" into zero-based indices.
enum PageRanges {
    static func parse(_ text: String, pageCount: Int) -> [Int]? {
        var result: [Int] = []
        for part in text.split(separator: ",") {
            let token = part.trimmingCharacters(in: .whitespaces)
            if token.isEmpty { continue }
            let bounds = token.split(separator: "-", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
            if bounds.count == 1, let n = Int(bounds[0]) {
                guard (1...pageCount).contains(n) else { return nil }
                result.append(n - 1)
            } else if bounds.count == 2 {
                let lo = bounds[0].isEmpty ? 1 : Int(bounds[0])
                let hi = bounds[1].isEmpty ? pageCount : Int(bounds[1])
                guard let lo, let hi, lo >= 1, hi <= pageCount, lo <= hi else { return nil }
                result.append(contentsOf: (lo - 1)...(hi - 1))
            } else {
                return nil
            }
        }
        return result.isEmpty ? nil : result
    }
}

extension NSColor {
    static let highlightPalette: [NSColor] = [
        .systemYellow, .systemGreen, .systemBlue, .systemPink, .systemOrange, .systemPurple, .systemRed, .black,
    ]
}

extension Binding where Value == NSColor {
    var swiftUI: Binding<Color> {
        Binding<Color>(get: { Color(nsColor: wrappedValue) }, set: { wrappedValue = NSColor($0) })
    }
}

extension URL {
    var baseName: String { deletingPathExtension().lastPathComponent }
}
