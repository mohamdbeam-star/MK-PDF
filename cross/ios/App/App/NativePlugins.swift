import UIKit
import SwiftUI
import Capacitor
import UniformTypeIdentifiers
#if canImport(Translation)
import Translation
#endif

/// The Capacitor web view, with MK PDF's own native plugins.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(OpenFilePlugin())
        bridge?.registerPluginInstance(TranslatePlugin())
    }
}

/// PDFs opened with MK PDF (from Files, Mail or a share sheet) are copied to a temporary folder and announced to
/// the web app as "open" events, held until it listens, so a file that launched the app isn't lost.
/// It also picks files with the system's document picker (the web view's file input often reports nothing the
/// first time) and opens the app's folder in the Files app.
@objc(OpenFilePlugin)
public class OpenFilePlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "OpenFilePlugin"
    public let jsName = "OpenFile"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pick", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showFolder", returnType: CAPPluginReturnPromise),
    ]
    private static var waiting: [[String: String]] = []
    private static weak var instance: OpenFilePlugin?
    private var picking: CAPPluginCall?

    /// `accept` is the web form: MIME types ("application/pdf", "image/*") and extensions (".pdf").
    @objc func pick(_ call: CAPPluginCall) {
        let accept = call.getString("accept") ?? ""
        var types: [UTType] = accept.split(separator: ",").compactMap { token in
            let t = token.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix(".") { return UTType(filenameExtension: String(t.dropFirst())) }
            if t.hasSuffix("/*") { return t.hasPrefix("image") ? .image : t.hasPrefix("text") ? .text : .item }
            return UTType(mimeType: t)
        }
        if types.isEmpty { types = [.item] }
        DispatchQueue.main.async {
            guard let parent = self.bridge?.viewController else { call.reject("Can't show the file picker."); return }
            self.picking?.resolve(["files": []])
            self.picking = call
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: true)
            picker.allowsMultipleSelection = call.getBool("multiple") ?? false
            picker.delegate = self
            parent.present(picker, animated: true)
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        // Copies (asCopy) live in the app's temporary folder; the web app reads and then deletes them.
        picking?.resolve(["files": urls.map { ["name": $0.lastPathComponent, "path": $0.absoluteString] }])
        picking = nil
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        picking?.resolve(["files": []])
        picking = nil
    }

    /// Opens the Files app where "On My iPhone › MK PDF" holds saved and exported files.
    @objc func showFolder(_ call: CAPPluginCall) {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        guard let url = URL(string: "shareddocuments://" + documents.path) else { call.reject("No folder."); return }
        DispatchQueue.main.async { UIApplication.shared.open(url) { ok in ok ? call.resolve() : call.reject("Files didn't open.") } }
    }

    override public func load() {
        Self.instance = self
        for file in Self.waiting { notifyListeners("open", data: file, retainUntilConsumed: true) }
        Self.waiting = []
    }

    static func offer(_ url: URL) {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("opened", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let copy = dir.appendingPathComponent("\(Int(Date().timeIntervalSince1970 * 1000))-\(url.lastPathComponent)")
        guard (try? FileManager.default.copyItem(at: url, to: copy)) != nil else { return }
        // Files sent from Mail and other apps arrive in Documents/Inbox, which Files would show beside saved files.
        if url.deletingLastPathComponent().lastPathComponent == "Inbox" { try? FileManager.default.removeItem(at: url) }
        let file = ["name": url.lastPathComponent, "path": copy.absoluteString]
        DispatchQueue.main.async {
            if let instance { instance.notifyListeners("open", data: file, retainUntilConsumed: true) } else { waiting.append(file) }
        }
    }
}

/// On-device translation with Apple's translator (iOS 18 or later), paragraph by paragraph, as on the Mac.
@objc(TranslatePlugin)
public class TranslatePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TranslatePlugin"
    public let jsName = "Translate"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "translate", returnType: CAPPluginReturnPromise),
    ]

    @objc func available(_ call: CAPPluginCall) {
        #if canImport(Translation)
        if #available(iOS 18.0, *) { call.resolve(["available": true]); return }
        #endif
        call.resolve(["available": false])
    }

    @objc func translate(_ call: CAPPluginCall) {
        guard let paragraphs = call.getArray("paragraphs", String.self), let target = call.getString("target") else {
            call.reject("Nothing to translate.")
            return
        }
        #if canImport(Translation)
        if #available(iOS 18.0, *) {
            DispatchQueue.main.async {
                guard let parent = self.bridge?.viewController else { call.reject("Translation isn't available."); return }
                var host: UIHostingController<TranslationRunner>?
                let runner = TranslationRunner(paragraphs: paragraphs, target: target) { result in
                    DispatchQueue.main.async {
                        host?.willMove(toParent: nil)
                        host?.view.removeFromSuperview()
                        host?.removeFromParent()
                        switch result {
                        case .success(let out): call.resolve(["paragraphs": out])
                        case .failure(let error): call.reject("Translation isn't available: \(error.localizedDescription)")
                        }
                    }
                }
                // The translator needs a view on screen (it may ask to download the language); this one is invisible.
                let h = UIHostingController(rootView: runner)
                host = h
                parent.addChild(h)
                h.view.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
                h.view.backgroundColor = .clear
                parent.view.addSubview(h.view)
                h.didMove(toParent: parent)
            }
            return
        }
        #endif
        call.reject("Translation needs iOS 18 or later.")
    }
}

#if canImport(Translation)
@available(iOS 18.0, *)
struct TranslationRunner: View {
    let paragraphs: [String]
    let target: String
    let done: (Result<[String], Error>) -> Void
    @State private var configuration: TranslationSession.Configuration?

    var body: some View {
        Color.clear
            .onAppear { configuration = .init(target: Locale.Language(identifier: target)) }
            .translationTask(configuration) { session in
                do {
                    var out: [String] = []
                    for p in paragraphs {
                        let text = p.trimmingCharacters(in: .whitespaces)
                        out.append(text.isEmpty ? "" : try await session.translate(text).targetText)
                    }
                    done(.success(out))
                } catch {
                    done(.failure(error))
                }
            }
    }
}
#endif
