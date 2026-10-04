// Renders each page of a PDF to a PNG, so a document can be looked at before
// it is sent.
//
//   swiftc -O scripts/pdf-pages.swift -o /tmp/pdf-pages
//   /tmp/pdf-pages docs/sample-walkthrough.pdf /tmp/pages 1.3
//
// Why this exists: `make-pdf.mjs` reports a page count and nothing else, and a
// page count is not a layout. The first build of KRAM/09 was eighteen pages
// with three of them half empty, a marker cut off at the edge of a picture and
// a section carried whole to the next sheet — none of which the build could
// say. The usual tool for this is poppler's `pdftoppm`, which needs Homebrew,
// which this machine deliberately does not have (log §3). PDFKit is already
// here.
//
// macOS only. Not part of any check; it is for a person's eyes.
import AppKit
import Foundation
import PDFKit

let args = CommandLine.arguments
guard args.count >= 3 else {
  print("Usage: pdf-pages <file.pdf> <out-dir> [scale]")
  exit(1)
}
let scale: CGFloat = args.count > 3 ? CGFloat(Double(args[3]) ?? 1.3) : 1.3
guard let doc = PDFDocument(url: URL(fileURLWithPath: args[1])) else {
  print("Cannot open \(args[1])")
  exit(1)
}
try? FileManager.default.createDirectory(atPath: args[2], withIntermediateDirectories: true)

for i in 0..<doc.pageCount {
  guard let page = doc.page(at: i) else { continue }
  let box = page.bounds(for: .mediaBox)
  let size = NSSize(width: box.width * scale, height: box.height * scale)
  let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: Int(size.width), pixelsHigh: Int(size.height),
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  let ctx = NSGraphicsContext(bitmapImageRep: rep)!
  NSGraphicsContext.current = ctx
  ctx.cgContext.setFillColor(NSColor.white.cgColor)
  ctx.cgContext.fill(CGRect(origin: .zero, size: size))
  ctx.cgContext.scaleBy(x: scale, y: scale)
  page.draw(with: .mediaBox, to: ctx.cgContext)
  NSGraphicsContext.restoreGraphicsState()
  let name = String(format: "%@/page-%02d.png", args[2], i + 1)
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: name))
}
print("\(doc.pageCount) pages")
