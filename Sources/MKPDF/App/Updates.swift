import AppKit
import SwiftUI
import UserNotifications

/// macOS notifications for finished tasks and new versions.
enum Notifier {
    static let updateCategory = "MKPDF_UPDATE"

    static func requestPermission() {
        let center = UNUserNotificationCenter.current()
        let download = UNNotificationAction(identifier: "download", title: "Download & Install", options: [.foreground])
        center.setNotificationCategories([UNNotificationCategory(identifier: updateCategory, actions: [download], intentIdentifiers: [])])
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    /// Posts when a long task finishes while the user is working in another app.
    static func taskFinished(_ title: String, detail: String) {
        guard !NSApp.isActive else { return }
        post(title: title, body: detail)
    }

    static func post(title: String, body: String, category: String? = nil) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        if let category { content.categoryIdentifier = category }
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }
}

/// Checks GitHub Releases for a newer MK PDF and offers to download it.
final class UpdateChecker: ObservableObject {
    static let shared = UpdateChecker()
    static let repository = "mohamdbeam-star/MK-PDF"

    struct Release: Equatable {
        let version: String
        let notes: String
        let page: URL
        let dmg: URL?
    }

    @Published private(set) var available: Release?
    @Published private(set) var checking = false
    @Published private(set) var downloadProgress: Double?
    private var timer: Timer?
    private var downloadObservation: NSKeyValueObservation?

    static var currentVersion: String {
        // MKPDF_VERSION_OVERRIDE lets a test build pretend to be older to exercise the update flow.
        ProcessInfo.processInfo.environment["MKPDF_VERSION_OVERRIDE"]
            ?? Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }

    var automatic: Bool {
        get { UserDefaults.standard.object(forKey: "checkForUpdates") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "checkForUpdates") }
    }

    /// Checks shortly after launch, then every six hours.
    func startAutomaticChecks() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { if self.automatic { self.check(userInitiated: false) } }
        timer = Timer.scheduledTimer(withTimeInterval: 6 * 3600, repeats: true) { _ in
            if self.automatic { self.check(userInitiated: false) }
        }
    }

    func check(userInitiated: Bool) {
        guard !checking else { return }
        checking = true
        // Recent releases, so a release that doesn't carry a Mac disk image can't hide one that does.
        var request = URLRequest(url: URL(string: "https://api.github.com/repos/\(Self.repository)/releases?per_page=15")!)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("MK-PDF/\(Self.currentVersion)", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: request) { data, response, error in
            let release = data.flatMap(Self.newest)
            DispatchQueue.main.async {
                self.checking = false
                guard let release else {
                    if userInitiated {
                        let status = (response as? HTTPURLResponse)?.statusCode
                        Panels.alert("Couldn't check for updates", error?.localizedDescription ?? "GitHub returned \(status.map(String.init) ?? "no response").")
                    }
                    return
                }
                self.handle(release, userInitiated: userInitiated)
            }
        }.resume()
    }

    private func handle(_ release: Release, userInitiated: Bool) {
        guard Self.isNewer(release.version, than: Self.currentVersion) else {
            available = nil
            if userInitiated { Panels.alert("MK PDF is up to date", "Version \(Self.currentVersion) is the latest.") }
            return
        }
        let skipped = UserDefaults.standard.string(forKey: "skippedVersion")
        if !userInitiated && skipped == release.version { return }
        let isNew = available?.version != release.version
        available = release
        if isNew && !userInitiated {
            Notifier.post(title: "MK PDF \(release.version) is available", body: "You have \(Self.currentVersion). Click to download the update.", category: Notifier.updateCategory)
        }
        if userInitiated { promptToInstall() }
    }

    func promptToInstall() {
        guard let release = available else { return }
        let alert = NSAlert()
        alert.messageText = "MK PDF \(release.version) is available"
        alert.informativeText = "You have version \(Self.currentVersion).\n\n" + String(release.notes.prefix(900))
        alert.addButton(withTitle: "Download & Install")
        alert.addButton(withTitle: "Later")
        alert.addButton(withTitle: "Skip This Version")
        switch alert.runModal() {
        case .alertFirstButtonReturn: downloadAndInstall()
        case .alertThirdButtonReturn: skip()
        default: break
        }
    }

    func skip() {
        guard let release = available else { return }
        UserDefaults.standard.set(release.version, forKey: "skippedVersion")
        available = nil
    }

    /// Downloads the release's disk image to Downloads and opens it so the new app can be dragged into Applications.
    func downloadAndInstall() {
        guard let release = available else { return }
        guard let dmg = release.dmg else { NSWorkspace.shared.open(release.page); return }
        downloadProgress = 0
        let task = URLSession.shared.downloadTask(with: dmg) { location, _, error in
            DispatchQueue.main.async {
                self.downloadProgress = nil
                guard let location else {
                    Panels.alert("Download failed", error?.localizedDescription ?? "")
                    return
                }
                let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
                let target = downloads.appendingPathComponent("MK PDF \(release.version).dmg")
                try? FileManager.default.removeItem(at: target)
                do {
                    try FileManager.default.moveItem(at: location, to: target)
                    NSWorkspace.shared.open(target)
                    Panels.alert("Update downloaded", "Drag MK PDF into Applications to replace this version, then reopen it.")
                } catch {
                    Panels.alert("Download failed", error.localizedDescription)
                }
            }
        }
        downloadObservation = task.progress.observe(\.fractionCompleted) { p, _ in
            DispatchQueue.main.async { if self.downloadProgress != nil { self.downloadProgress = p.fractionCompleted } }
        }
        task.resume()
    }

    /// The highest-versioned published release that has a .dmg.
    static func newest(_ data: Data) -> Release? {
        guard let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return parse(data) }
        return list.filter { ($0["draft"] as? Bool) != true && ($0["prerelease"] as? Bool) != true }
            .compactMap { (try? JSONSerialization.data(withJSONObject: $0)).flatMap(parse) }
            .filter { $0.dmg != nil }
            .max { isNewer($1.version, than: $0.version) }
    }

    static func parse(_ data: Data) -> Release? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let tag = json["tag_name"] as? String,
              let page = (json["html_url"] as? String).flatMap(URL.init(string:)) else { return nil }
        let assets = json["assets"] as? [[String: Any]] ?? []
        let dmg = assets.first { ($0["name"] as? String)?.lowercased().hasSuffix(".dmg") == true }?["browser_download_url"] as? String
        let version = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
        return Release(version: version, notes: json["body"] as? String ?? "", page: page, dmg: dmg.flatMap(URL.init(string:)))
    }

    /// Numeric comparison of dotted versions ("1.10.0" > "1.9.2").
    static func isNewer(_ a: String, than b: String) -> Bool {
        let pa = a.split(separator: ".").map { Int($0) ?? 0 }, pb = b.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(pa.count, pb.count) {
            let x = i < pa.count ? pa[i] : 0, y = i < pb.count ? pb[i] : 0
            if x != y { return x > y }
        }
        return false
    }
}

/// Shown at the top of windows while a newer version is available.
struct UpdateBanner: View {
    @ObservedObject var updates = UpdateChecker.shared

    var body: some View {
        if let release = updates.available {
            HStack(spacing: 10) {
                Image(systemName: "arrow.down.circle.fill").foregroundStyle(Color.accentColor)
                Text("MK PDF \(release.version) is available").font(.callout.bold())
                Text("You have \(UpdateChecker.currentVersion)").font(.callout).foregroundStyle(.secondary)
                Spacer()
                if let p = updates.downloadProgress {
                    ProgressView(value: p).frame(width: 120)
                } else {
                    Button("What's New") { NSWorkspace.shared.open(release.page) }.buttonStyle(.link)
                    Button("Download & Install") { updates.downloadAndInstall() }.buttonStyle(.borderedProminent).controlSize(.small)
                    Button { updates.skip() } label: { Image(systemName: "xmark") }.buttonStyle(.borderless).help("Skip this version")
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .glassCapsule(tint: Color.accentColor.opacity(0.18))
            .padding(.horizontal, 10)
            .padding(.top, 6)
        }
    }
}
