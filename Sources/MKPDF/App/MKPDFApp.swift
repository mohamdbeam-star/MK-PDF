import SwiftUI
import PDFKit

@main
struct MKPDFApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    init() { EditSmokeTest.runIfRequested() }

    var body: some Scene {
        DocumentGroup(newDocument: { PDFFileDocument() }) { file in
            DocumentWindow(document: file.document, fileURL: file.fileURL)
        }
        .commands { MKPDFCommands() }

        Window("MK PDF", id: "home") {
            HomeView()
        }
        .defaultLaunchBehavior(.presented)
        .windowResizability(.contentSize)

        Window("Combine Files", id: "combine") {
            CombineView()
        }
        .defaultSize(width: 620, height: 520)

        WindowGroup("Compare Files", id: "compare", for: CompareRequest.self) { $request in
            if let request {
                CompareView(request: request)
            }
        }
        .defaultSize(width: 1200, height: 800)

        Settings {
            SettingsView()
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    // The home window replaces the empty untitled document macOS would otherwise open at launch.
    func applicationShouldOpenUntitledFile(_ sender: NSApplication) -> Bool { false }
}

/// Opens a PDF built in memory (combine, create from images, …) as a new untitled document window.
enum DocumentLauncher {
    static var pending: PDFDocument?

    static func open(_ pdf: PDFDocument) {
        pending = pdf
        NSDocumentController.shared.newDocument(nil)
    }

    static func open(url: URL) {
        NSDocumentController.shared.openDocument(withContentsOf: url, display: true) { _, _, error in
            if let error { Panels.alert("Couldn't open \(url.lastPathComponent)", error.localizedDescription) }
        }
    }
}
