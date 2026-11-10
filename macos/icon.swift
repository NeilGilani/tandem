// Draws the Tandem app icon at every size macOS needs, into an .iconset folder.
// Usage: swift icon.swift <out.iconset>
import AppKit

let out = URL(fileURLWithPath: CommandLine.arguments[1])
try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

func draw(_ px: Int) -> Data {
    let s = CGFloat(px)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    // Apple's icon grid: a rounded square inset ~10% with a soft shadow.
    let inset = s * 0.098, side = s - inset * 2
    let rect = NSRect(x: inset, y: inset * 1.12, width: side, height: side)
    let path = NSBezierPath(roundedRect: rect, xRadius: side * 0.225, yRadius: side * 0.225)
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.28)
    shadow.shadowBlurRadius = s * 0.02
    shadow.shadowOffset = NSSize(width: 0, height: -s * 0.008)
    shadow.set()
    NSGradient(colors: [NSColor(calibratedRed: 0.17, green: 0.17, blue: 0.19, alpha: 1), NSColor(calibratedRed: 0.04, green: 0.04, blue: 0.05, alpha: 1)])!
        .draw(in: path, angle: -90)
    NSShadow().set()
    // Subtle top highlight.
    NSColor.white.withAlphaComponent(0.06).setStroke()
    path.lineWidth = s * 0.004
    path.stroke()
    // Two linked rings.
    let r = side * 0.205, lw = side * 0.09
    let cy = rect.midY
    let left = NSBezierPath(ovalIn: NSRect(x: rect.midX - side * 0.11 - r, y: cy - r, width: r * 2, height: r * 2))
    left.lineWidth = lw
    NSColor.white.setStroke(); left.stroke()
    let right = NSBezierPath(ovalIn: NSRect(x: rect.midX + side * 0.11 - r, y: cy - r, width: r * 2, height: r * 2))
    right.lineWidth = lw
    NSColor(calibratedRed: 0.56, green: 0.71, blue: 0.96, alpha: 1).setStroke(); right.stroke()
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

for (name, px) in [("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64), ("128x128", 128), ("128x128@2x", 256),
                   ("256x256", 256), ("256x256@2x", 512), ("512x512", 512), ("512x512@2x", 1024)] {
    try! draw(px).write(to: out.appendingPathComponent("icon_\(name).png"))
}
