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
    /// A downloaded new version waiting to replace this app (installed on restart, or when MK PDF quits).
    @Published private(set) var staged: (release: Release, app: URL)?
    private var timer: Timer?
    private var lastCheck = Date.distantPast
    private var observers: [NSObjectProtocol] = []
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

    /// Checks shortly after launch, every hour, and whenever MK PDF comes to the front or the Mac wakes (at most every
    /// 15 minutes), so a new release shows up soon after it's published.
    func startAutomaticChecks() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { if self.automatic { self.check(userInitiated: false) } }
        timer = Timer.scheduledTimer(withTimeInterval: 3600, repeats: true) { _ in
            if self.automatic { self.check(userInitiated: false) }
        }
        timer?.tolerance = 300
        let soon = { [weak self] (_: Notification) in
            guard let self, self.automatic, Date().timeIntervalSince(self.lastCheck) > 15 * 60 else { return }
            self.check(userInitiated: false)
        }
        observers = [
            NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main, using: soon),
            NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main, using: soon),
        ]
    }

    func check(userInitiated: Bool) {
        guard !checking else { return }
        checking = true
        lastCheck = Date()
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

    /// Where this copy of MK PDF lives, when it can be replaced in place (not run from a disk image or a
    /// translocated quarantine copy).
    static var replaceableBundle: URL? {
        let url = Bundle.main.bundleURL
        guard url.pathExtension == "app", !url.path.hasPrefix("/Volumes/"), !url.path.contains("/AppTranslocation/") else { return nil }
        return url
    }

    /// Downloads the release's disk image, takes the new app out of it and replaces this copy, then restarts.
    /// Where this copy can't be replaced (run from a disk image), the disk image is opened to drag it in instead.
    func downloadAndInstall() {
        guard let release = available else { return }
        if let staged, staged.release == release { restartToInstall(); return }
        guard let dmg = release.dmg else { NSWorkspace.shared.open(release.page); return }
        downloadProgress = 0
        let task = URLSession.shared.downloadTask(with: dmg) { location, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            var result: Result<URL, Error> = .failure(Failure(error?.localizedDescription ?? "GitHub returned \(status)."))
            if let location, error == nil, (200..<300).contains(status) {
                result = Result { try Self.unpack(dmg: location, expecting: release.version) }
            }
            DispatchQueue.main.async {
                self.downloadProgress = nil
                switch result {
                case .success(let app):
                    guard Self.replaceableBundle != nil else { self.openForManualInstall(app, release: release); return }
                    self.staged = (release, app)
                    let alert = NSAlert()
                    alert.messageText = "MK PDF \(release.version) is ready to install"
                    alert.informativeText = "MK PDF will restart to finish. Your open documents will be closed (you'll be asked to save changes)."
                    alert.addButton(withTitle: "Restart Now")
                    alert.addButton(withTitle: "When I Quit")
                    if alert.runModal() == .alertFirstButtonReturn { self.restartToInstall() }
                case .failure(let error):
                    Panels.alert("Couldn't install the update", error.localizedDescription)
                }
            }
        }
        downloadObservation = task.progress.observe(\.fractionCompleted) { p, _ in
            DispatchQueue.main.async { if self.downloadProgress != nil { self.downloadProgress = p.fractionCompleted } }
        }
        task.resume()
    }

    struct Failure: LocalizedError { let errorDescription: String?; init(_ s: String) { errorDescription = s } }

    /// Mounts the disk image, copies MK PDF out of it to a private folder and checks it's the expected version.
    static func unpack(dmg: URL, expecting version: String) throws -> URL {
        let fm = FileManager.default
        let work = fm.temporaryDirectory.appendingPathComponent("MKPDF-update-\(UUID().uuidString)")
        let mount = work.appendingPathComponent("mount"), image = work.appendingPathComponent("update.dmg")
        try fm.createDirectory(at: mount, withIntermediateDirectories: true)
        try fm.moveItem(at: dmg, to: image)
        try run("/usr/bin/hdiutil", ["attach", image.path, "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount.path])
        defer { _ = try? run("/usr/bin/hdiutil", ["detach", mount.path, "-force"]) }
        guard let name = try fm.contentsOfDirectory(atPath: mount.path).first(where: { $0.hasSuffix(".app") }) else { throw Failure("The download doesn't contain MK PDF.") }
        let app = work.appendingPathComponent(name)
        try run("/usr/bin/ditto", [mount.appendingPathComponent(name).path, app.path])
        let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist"))
        guard info?["CFBundleIdentifier"] as? String == Bundle.main.bundleIdentifier else { throw Failure("The download isn't MK PDF.") }
        guard info?["CFBundleShortVersionString"] as? String == version else { throw Failure("The download is a different version than expected.") }
        return app
    }

    @discardableResult
    static func run(_ tool: String, _ args: [String]) throws -> String {
        let p = Process(), out = Pipe()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        p.standardOutput = out
        p.standardError = out
        try p.run()
        p.waitUntilExit()
        let text = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        guard p.terminationStatus == 0 else { throw Failure("\((tool as NSString).lastPathComponent) failed: \(text.prefix(200))") }
        return text
    }

    /// Quits MK PDF; a helper waits for it to exit, swaps in the new app (keeping the old one if that fails) and
    /// reopens it.
    func restartToInstall() {
        guard installStagedUpdate(relaunch: true) else { return }
        NSApp.terminate(nil)
    }

    /// Starts the helper that replaces this app with the staged update once MK PDF has quit. Called on restart and
    /// when the user quits with an update waiting.
    @discardableResult
    func installStagedUpdate(relaunch: Bool) -> Bool {
        guard let staged, let target = Self.replaceableBundle else { return false }
        func q(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        let t = target.path, old = t + ".old"
        let swap = """
        rm -rf \(q(old))
        if mv \(q(t)) \(q(old)) && /usr/bin/ditto \(q(staged.app.path)) \(q(t)); then rm -rf \(q(old)); else rm -rf \(q(t)); mv \(q(old)) \(q(t)); fi
        /usr/bin/xattr -dr com.apple.quarantine \(q(t)) 2>/dev/null
        exit 0
        """
        let work = staged.app.deletingLastPathComponent()
        let swapScript = work.appendingPathComponent("swap.sh")
        // An Applications folder the user can't write to needs an administrator's password (macOS asks once).
        let fm = FileManager.default
        let needsAdmin = !fm.isWritableFile(atPath: target.deletingLastPathComponent().path) || !fm.isWritableFile(atPath: t)
        let runSwap = needsAdmin
            ? "/usr/bin/osascript -e \(q("do shell script \"/bin/sh " + q(swapScript.path).replacingOccurrences(of: "\"", with: "\\\"") + "\" with administrator privileges"))"
            : "/bin/sh \(q(swapScript.path))"
        let script = """
        while kill -0 \(ProcessInfo.processInfo.processIdentifier) 2>/dev/null; do sleep 0.3; done
        \(runSwap)
        \(relaunch ? "/usr/bin/open " + q(t) : "")
        """
        let helper = Process()
        helper.executableURL = URL(fileURLWithPath: "/bin/sh")
        helper.arguments = ["-c", script]
        do {
            try swap.write(to: swapScript, atomically: true, encoding: .utf8)
            try helper.run()
        } catch { Panels.alert("Couldn't install the update", error.localizedDescription); return false }
        self.staged = nil
        return true
    }

    /// Fallback when this copy runs from a disk image: show the new app in Finder to drag into Applications.
    private func openForManualInstall(_ app: URL, release: Release) {
        NSWorkspace.shared.activateFileViewerSelecting([app])
        Panels.alert("Update downloaded", "MK PDF is running from a disk image, so it can't replace itself. Drag MK PDF \(release.version) into Applications, then open it from there.")
    }

    /// `MKPDF --install-update-test`: downloads the newest release, unpacks it and replaces this copy of the app when
    /// it exits (run a copy outside Applications to test the update flow without the UI).
    func runInstallTestIfRequested() {
        guard CommandLine.arguments.contains("--install-update-test") else { return }
        let done = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: URL(string: "https://api.github.com/repos/\(Self.repository)/releases?per_page=15")!) { data, _, _ in
            defer { done.signal() }
            guard let release = data.flatMap(Self.newest), let dmg = release.dmg, let file = try? Data(contentsOf: dmg) else { print("no release"); return }
            let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).dmg")
            do {
                try file.write(to: tmp)
                let app = try Self.unpack(dmg: tmp, expecting: release.version)
                self.staged = (release, app)
                print("unpacked \(release.version) to \(app.path)")
                print(self.installStagedUpdate(relaunch: false) ? "helper started for \(Self.replaceableBundle?.path ?? "?")" : "can't replace this copy")
            } catch { print("failed: \(error.localizedDescription)") }
        }.resume()
        done.wait()
        exit(0)
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
                    Button(updates.staged?.release == release ? "Restart to Update" : "Download & Install") { updates.downloadAndInstall() }
                        .buttonStyle(.borderedProminent).controlSize(.small)
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
