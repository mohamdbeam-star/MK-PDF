import SwiftUI
import PDFKit

/// Saved signatures and initials, kept as transparent PNGs in Application Support.
final class SignatureStore: ObservableObject {
    static let shared = SignatureStore()

    struct Item: Identifiable {
        let id: String
        let kind: String
        let image: NSImage
        let url: URL
    }

    @Published private(set) var items: [Item] = []

    private var folder: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("MK PDF/Signatures", isDirectory: true)
    }

    init() { reload() }

    func reload() {
        let urls = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.creationDateKey])) ?? []
        items = urls.filter { $0.pathExtension == "png" }.sorted { $0.lastPathComponent < $1.lastPathComponent }.compactMap { url in
            guard let image = NSImage(contentsOf: url) else { return nil }
            let kind = url.lastPathComponent.hasPrefix("Initials") ? "Initials" : "Signature"
            return Item(id: url.lastPathComponent, kind: kind, image: image, url: url)
        }
    }

    func add(_ image: NSImage, kind: String) {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        guard let png = image.pngData() else { return }
        let name = "\(kind)-\(Int(Date().timeIntervalSince1970)).png"
        try? png.write(to: folder.appendingPathComponent(name))
        reload()
    }

    func delete(_ item: Item) {
        try? FileManager.default.removeItem(at: item.url)
        reload()
    }
}

extension EditorModel {
    /// Arms the place tool: the next click on a page drops `image` there.
    func armImage(_ image: NSImage, kind: String) {
        placingImage = image
        placingKind = kind
        tool = .stamp
    }

    func armSignature(_ image: NSImage, kind: String) {
        SignatureStore.shared.add(image, kind: kind)
        armImage(image, kind: kind)
    }

    func pickImageToPlace() {
        guard let url = Panels.open(Panels.imageTypes, title: "Choose an image to add").first,
              let image = NSImage(contentsOf: url) else { return }
        armImage(image, kind: "Image")
    }
}

/// Draw, type or import a signature.
struct SignatureCaptureView: View {
    enum Kind { case signature, initials }
    enum Mode: String, CaseIterable { case draw = "Draw", type = "Type", image = "Image" }

    let kind: Kind
    let onDone: (NSImage) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var mode = Mode.draw
    @State private var strokes: [[CGPoint]] = []
    @State private var current: [CGPoint] = []
    @State private var typed = NSFullUserName()
    @State private var font = "Snell Roundhand"
    @State private var imported: NSImage?
    @State private var ink = Color.black

    private let fonts = ["Snell Roundhand", "Bradley Hand", "Zapfino", "Savoye LET", "Noteworthy", "Chalkboard SE"]
    private let canvas = CGSize(width: 480, height: 170)

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(kind == .signature ? "Add Signature" : "Add Initials").font(.title2.bold())
            Picker("", selection: $mode) { ForEach(Mode.allCases, id: \.self) { Text($0.rawValue) } }
                .pickerStyle(.segmented).labelsHidden()
            ZStack {
                RoundedRectangle(cornerRadius: 10).fill(Color.white)
                RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.4))
                Path { p in p.move(to: CGPoint(x: 30, y: canvas.height - 40)); p.addLine(to: CGPoint(x: canvas.width - 30, y: canvas.height - 40)) }
                    .stroke(Color.secondary.opacity(0.3), style: StrokeStyle(lineWidth: 1, dash: [4]))
                switch mode {
                case .draw:
                    Canvas { ctx, _ in
                        for s in strokes + [current] where s.count > 1 {
                            ctx.stroke(path(s), with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
                        }
                    }
                    .gesture(DragGesture(minimumDistance: 0)
                        .onChanged { current.append($0.location) }
                        .onEnded { _ in strokes.append(current); current = [] })
                case .type:
                    Text(typed).font(.custom(font, size: kind == .signature ? 54 : 64)).foregroundStyle(ink)
                        .lineLimit(1).minimumScaleFactor(0.3).padding(.horizontal, 20)
                case .image:
                    if let imported {
                        Image(nsImage: imported).resizable().aspectRatio(contentMode: .fit).padding(10)
                    } else {
                        Button("Choose Image…") { imported = Panels.open(Panels.imageTypes).first.flatMap(NSImage.init(contentsOf:)) }
                    }
                }
            }
            .frame(width: canvas.width, height: canvas.height)
            HStack {
                switch mode {
                case .draw: Button("Clear") { strokes = []; current = [] }
                case .type:
                    TextField("Name", text: $typed).textFieldStyle(.roundedBorder).frame(width: 180)
                    Picker("", selection: $font) { ForEach(fonts, id: \.self) { Text($0).font(.custom($0, size: 14)) } }
                        .labelsHidden().frame(width: 150)
                case .image: Button("Choose Another…") { imported = Panels.open(Panels.imageTypes).first.flatMap(NSImage.init(contentsOf:)) }
                }
                Spacer()
                if mode != .image {
                    ForEach([Color.black, Color(red: 0.1, green: 0.2, blue: 0.6), Color(red: 0.6, green: 0.1, blue: 0.1)], id: \.self) { c in
                        Circle().fill(c).frame(width: 18, height: 18)
                            .overlay(Circle().stroke(Color.accentColor, lineWidth: ink == c ? 2 : 0))
                            .onTapGesture { ink = c }
                    }
                }
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Save and Place") {
                    if let image = render() { onDone(image) }
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(render() == nil)
            }
        }
        .padding(22)
    }

    private func path(_ points: [CGPoint]) -> Path {
        Path { p in
            p.move(to: points[0])
            for pt in points.dropFirst() { p.addLine(to: pt) }
        }
    }

    /// Renders the signature at 3× and trims it to its ink.
    private func render() -> NSImage? {
        switch mode {
        case .image:
            return imported
        case .draw:
            let all = strokes.flatMap { $0 } + current
            guard all.count > 2 else { return nil }
            let xs = all.map(\.x), ys = all.map(\.y)
            let box = CGRect(x: xs.min()! - 6, y: ys.min()! - 6, width: xs.max()! - xs.min()! + 12, height: ys.max()! - ys.min()! + 12)
            let color = NSColor(ink)
            return NSImage(size: box.size, flipped: true) { _ in
                color.setStroke()
                for s in strokes + [current] where s.count > 1 {
                    let p = NSBezierPath()
                    p.lineWidth = 3
                    p.lineCapStyle = .round
                    p.lineJoinStyle = .round
                    p.move(to: CGPoint(x: s[0].x - box.minX, y: s[0].y - box.minY))
                    for pt in s.dropFirst() { p.line(to: CGPoint(x: pt.x - box.minX, y: pt.y - box.minY)) }
                    p.stroke()
                }
                return true
            }
        case .type:
            let text = typed.trimmingCharacters(in: .whitespaces)
            guard !text.isEmpty else { return nil }
            let nsFont = NSFont(name: font, size: 64) ?? .systemFont(ofSize: 64)
            let attributed = NSAttributedString(string: text, attributes: [.font: nsFont, .foregroundColor: NSColor(ink)])
            let size = attributed.size()
            return NSImage(size: CGSize(width: size.width + 16, height: size.height + 8), flipped: false) { _ in
                attributed.draw(at: CGPoint(x: 8, y: 4))
                return true
            }
        }
    }
}
