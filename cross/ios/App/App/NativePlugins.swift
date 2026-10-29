import UIKit
import SwiftUI
import Capacitor
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
@objc(OpenFilePlugin)
public class OpenFilePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OpenFilePlugin"
    public let jsName = "OpenFile"
    public let pluginMethods: [CAPPluginMethod] = []
    private static var waiting: [[String: String]] = []
    private static weak var instance: OpenFilePlugin?

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
