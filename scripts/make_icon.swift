import AppKit

// Renders the MK PDF icon: a glass page with a folded corner and an editing cursor over a deep
// red-to-violet squircle, in the layered, light-catching style of macOS 26 icons.
//
//   swift scripts/make_icon.swift icon.png                 full icon (1024 px)
//   swift scripts/make_icon.swift icon.png fg.png bg.png   also the foreground / background layers (Android)

let size: CGFloat = 1024
let args = CommandLine.arguments

func render(_ draw: (CGContext) -> Void) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size), bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    draw(NSGraphicsContext.current!.cgContext)
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

let space = CGColorSpace(name: CGColorSpace.sRGB)!
func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor { CGColor(colorSpace: space, components: [r, g, b, a])! }
func gradient(_ stops: [(CGFloat, CGColor)]) -> CGGradient {
    CGGradient(colorsSpace: space, colors: stops.map(\.1) as CFArray, locations: stops.map(\.0))!
}

/// Continuous-corner rounded square like Apple's icon grid.
func squircle(_ rect: CGRect) -> CGPath {
    // Superellipse |x|^n + |y|^n = 1 with n = 5, close to Apple's continuous-corner icon shape.
    let path = CGMutablePath()
    let n = 5.0, steps = 720
    for i in 0...steps {
        let t = Double(i) / Double(steps) * 2 * .pi
        let c = cos(t), s = sin(t)
        let x = pow(abs(c), 2 / n) * (c < 0 ? -1 : 1), y = pow(abs(s), 2 / n) * (s < 0 ? -1 : 1)
        let p = CGPoint(x: rect.midX + CGFloat(x) * rect.width / 2, y: rect.midY + CGFloat(y) * rect.height / 2)
        if i == 0 { path.move(to: p) } else { path.addLine(to: p) }
    }
    path.closeSubpath()
    return path
}

func drawBackground(_ ctx: CGContext, full: Bool) {
    // Full-bleed artwork: macOS 26 masks it to the system icon shape (a smaller tile with transparent
    // margins would be shown inside a grey box).
    let rect = CGRect(x: 0, y: 0, width: size, height: size)
    ctx.saveGState()
    ctx.drawLinearGradient(gradient([(0, color(1.0, 0.33, 0.30)), (0.45, color(0.90, 0.11, 0.38)), (1, color(0.42, 0.13, 0.78))]),
                           start: CGPoint(x: rect.minX, y: rect.maxY), end: CGPoint(x: rect.maxX, y: rect.minY), options: [])
    // Light pooling from the top-left and a deep glow at the bottom-right.
    ctx.drawRadialGradient(gradient([(0, color(1, 0.85, 0.7, 0.55)), (1, color(1, 0.85, 0.7, 0))]),
                           startCenter: CGPoint(x: rect.minX + rect.width * 0.22, y: rect.maxY - rect.height * 0.18), startRadius: 0,
                           endCenter: CGPoint(x: rect.minX + rect.width * 0.22, y: rect.maxY - rect.height * 0.18), endRadius: rect.width * 0.62, options: [])
    ctx.drawRadialGradient(gradient([(0, color(0.25, 0.05, 0.6, 0.55)), (1, color(0.25, 0.05, 0.6, 0))]),
                           startCenter: CGPoint(x: rect.maxX, y: rect.minY), startRadius: 0,
                           endCenter: CGPoint(x: rect.maxX, y: rect.minY), endRadius: rect.width * 0.7, options: [])
    if full && false {
        ctx.addPath(squircle(rect.insetBy(dx: 3, dy: 3)))
        ctx.setLineWidth(6)
        ctx.replacePathWithStrokedPath()
        ctx.clip()
        ctx.drawLinearGradient(gradient([(0, color(1, 1, 1, 0.7)), (0.5, color(1, 1, 1, 0.05)), (1, color(0, 0, 0, 0.25))]),
                               start: CGPoint(x: 0, y: rect.maxY), end: CGPoint(x: 0, y: rect.minY), options: [])
    }
    ctx.restoreGState()
}

func drawForeground(_ ctx: CGContext, scale: CGFloat) {
    ctx.saveGState()
    // Foreground art is designed for the full icon; Android's safe zone needs it a little smaller.
    ctx.translateBy(x: size / 2, y: size / 2)
    ctx.scaleBy(x: scale, y: scale)
    ctx.translateBy(x: -size / 2, y: -size / 2)

    // The page: frosted glass, folded top-right corner.
    let page = CGMutablePath()
    let l: CGFloat = 300, r: CGFloat = 724, b: CGFloat = 230, t: CGFloat = 800, fold: CGFloat = 120
    page.move(to: CGPoint(x: l + 40, y: b))
    page.addLine(to: CGPoint(x: r - 40, y: b)); page.addQuadCurve(to: CGPoint(x: r, y: b + 40), control: CGPoint(x: r, y: b))
    page.addLine(to: CGPoint(x: r, y: t - fold)); page.addLine(to: CGPoint(x: r - fold, y: t))
    page.addLine(to: CGPoint(x: l + 40, y: t)); page.addQuadCurve(to: CGPoint(x: l, y: t - 40), control: CGPoint(x: l, y: t))
    page.addLine(to: CGPoint(x: l, y: b + 40)); page.addQuadCurve(to: CGPoint(x: l + 40, y: b), control: CGPoint(x: l, y: b))
    page.closeSubpath()

    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -22), blur: 46, color: color(0.25, 0, 0.2, 0.45))
    ctx.addPath(page); ctx.setFillColor(color(1, 1, 1, 0.82)); ctx.fillPath()
    ctx.restoreGState()
    ctx.saveGState()
    ctx.addPath(page); ctx.clip()
    ctx.drawLinearGradient(gradient([(0, color(1, 1, 1, 0.95)), (1, color(1, 0.92, 0.96, 0.7))]),
                           start: CGPoint(x: l, y: t), end: CGPoint(x: r, y: b), options: [])
    // Specular sweep across the glass.
    let sweep = CGMutablePath()
    sweep.move(to: CGPoint(x: l - 40, y: t - 60)); sweep.addLine(to: CGPoint(x: l + 220, y: t + 40))
    sweep.addLine(to: CGPoint(x: l + 40, y: b + 200)); sweep.addLine(to: CGPoint(x: l - 100, y: b + 120)); sweep.closeSubpath()
    ctx.addPath(sweep); ctx.setFillColor(color(1, 1, 1, 0.35)); ctx.fillPath()
    ctx.restoreGState()
    // Bright rim on the page.
    ctx.addPath(page); ctx.setStrokeColor(color(1, 1, 1, 0.95)); ctx.setLineWidth(5); ctx.strokePath()

    // The folded corner.
    let corner = CGMutablePath()
    corner.move(to: CGPoint(x: r - fold, y: t)); corner.addLine(to: CGPoint(x: r - fold, y: t - fold + 28))
    corner.addQuadCurve(to: CGPoint(x: r - fold + 28, y: t - fold), control: CGPoint(x: r - fold, y: t - fold))
    corner.addLine(to: CGPoint(x: r, y: t - fold)); corner.closeSubpath()
    ctx.saveGState()
    ctx.addPath(corner); ctx.clip()
    ctx.drawLinearGradient(gradient([(0, color(0.98, 0.78, 0.86)), (1, color(0.86, 0.62, 0.95))]),
                           start: CGPoint(x: r - fold, y: t), end: CGPoint(x: r, y: t - fold), options: [])
    ctx.restoreGState()

    // Text lines on the page, the last one being edited.
    ctx.setLineCap(.round)
    let lineColor = color(0.55, 0.14, 0.42, 0.35)
    for (i, w) in [CGFloat(250), 300, 210].enumerated() {
        ctx.setStrokeColor(lineColor); ctx.setLineWidth(22)
        ctx.move(to: CGPoint(x: l + 62, y: t - 170 - CGFloat(i) * 62)); ctx.addLine(to: CGPoint(x: l + 62 + w, y: t - 170 - CGFloat(i) * 62)); ctx.strokePath()
    }

    // "MK" monogram.
    let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 172, weight: .heavy),
                                                .foregroundColor: NSColor(red: 0.86, green: 0.12, blue: 0.36, alpha: 1), .kern: -4]
    let mk = NSAttributedString(string: "MK", attributes: attrs)
    let ms = mk.size()
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -4), blur: 10, color: color(0.5, 0, 0.3, 0.25))
    mk.draw(at: CGPoint(x: l + 58, y: b + 52))
    ctx.restoreGState()

    // Glowing text cursor beside the monogram: the "edit" in MK PDF.
    let cx = l + 58 + ms.width + 30
    ctx.saveGState()
    ctx.setShadow(offset: .zero, blur: 28, color: color(1, 0.45, 0.85, 0.9))
    ctx.setStrokeColor(color(0.62, 0.18, 0.92)); ctx.setLineWidth(20)
    ctx.move(to: CGPoint(x: cx, y: b + 74)); ctx.addLine(to: CGPoint(x: cx, y: b + 230)); ctx.strokePath()
    ctx.setLineWidth(14)
    for y in [b + 74, b + 230] {
        ctx.move(to: CGPoint(x: cx - 26, y: y)); ctx.addLine(to: CGPoint(x: cx + 26, y: y)); ctx.strokePath()
    }
    ctx.restoreGState()
    ctx.restoreGState()
}

try! render { ctx in drawBackground(ctx, full: true); drawForeground(ctx, scale: 1.12) }.write(to: URL(fileURLWithPath: args[1]))
if args.count > 3 {
    try! render { ctx in drawForeground(ctx, scale: 0.78) }.write(to: URL(fileURLWithPath: args[2]))
    try! render { ctx in drawBackground(ctx, full: false) }.write(to: URL(fileURLWithPath: args[3]))
}
