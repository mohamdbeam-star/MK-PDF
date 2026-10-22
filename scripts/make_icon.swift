import AppKit

// Renders the MK PDF app icon to a 1024px PNG.
let size = 1024.0
let img = NSImage(size: NSSize(width: size, height: size))
img.lockFocus()
let rect = NSRect(x: 0, y: 0, width: size, height: size).insetBy(dx: 80, dy: 80)
let path = NSBezierPath(roundedRect: rect, xRadius: 190, yRadius: 190)
NSGradient(colors: [NSColor(red: 0.90, green: 0.16, blue: 0.22, alpha: 1), NSColor(red: 0.55, green: 0.05, blue: 0.36, alpha: 1)])!
    .draw(in: path, angle: -45)
// A page with a folded corner.
let page = NSBezierPath()
page.move(to: NSPoint(x: 330, y: 250))
page.line(to: NSPoint(x: 330, y: 780))
page.line(to: NSPoint(x: 580, y: 780))
page.line(to: NSPoint(x: 700, y: 660))
page.line(to: NSPoint(x: 700, y: 250))
page.close()
NSColor.white.withAlphaComponent(0.95).setFill()
page.fill()
let fold = NSBezierPath()
fold.move(to: NSPoint(x: 580, y: 780))
fold.line(to: NSPoint(x: 580, y: 660))
fold.line(to: NSPoint(x: 700, y: 660))
fold.close()
NSColor(white: 0.85, alpha: 1).setFill()
fold.fill()
let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 150, weight: .heavy), .foregroundColor: NSColor(red: 0.78, green: 0.1, blue: 0.25, alpha: 1)]
let s = NSAttributedString(string: "MK", attributes: attrs)
s.draw(at: NSPoint(x: 515 - s.size().width / 2, y: 330))
img.unlockFocus()
let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
