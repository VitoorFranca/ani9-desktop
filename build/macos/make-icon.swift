// Makes build/macos/icon.icns from the web app's icon (app/client/public/icon-512.png):
// the macOS shape (rounded square of 824 px on a 1024 px canvas, soft shadow).
// Run: swift build/macos/make-icon.swift <icon-512.png> && iconutil -c icns build/macos/icon.iconset
import AppKit

let source = NSImage(contentsOfFile: CommandLine.arguments[1])!
let iconset = "build/macos/icon.iconset"
try? FileManager.default.createDirectory(atPath: iconset, withIntermediateDirectories: true)

func render(_ size: Int) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let scale = CGFloat(size) / 1024
    let rect = NSRect(x: 100 * scale, y: 100 * scale, width: 824 * scale, height: 824 * scale)
    let path = NSBezierPath(roundedRect: rect, xRadius: 185 * scale, yRadius: 185 * scale)
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.3)
    shadow.shadowBlurRadius = 20 * scale
    shadow.shadowOffset = NSSize(width: 0, height: -8 * scale)
    NSGraphicsContext.saveGraphicsState()
    shadow.set()
    NSColor(red: 0.105, green: 0.105, blue: 0.09, alpha: 1).setFill()
    path.fill()
    NSGraphicsContext.restoreGraphicsState()
    path.addClip()
    source.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

for base in [16, 32, 128, 256, 512] {
    try! render(base).write(to: URL(fileURLWithPath: "\(iconset)/icon_\(base)x\(base).png"))
    try! render(base * 2).write(to: URL(fileURLWithPath: "\(iconset)/icon_\(base)x\(base)@2x.png"))
}
