import AppKit
import ApplicationServices
import ImageIO

struct Raster {
    let width: Int
    let height: Int
    let pixels: [UInt8]

    init?(_ path: String) {
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
              image.width <= 8192, image.height <= 8192 else { return nil }
        width = image.width
        height = image.height
        var buffer = [UInt8](repeating: 0, count: width * height * 4)
        let drawn = buffer.withUnsafeMutableBytes { storage -> Bool in
            guard let context = CGContext(data: storage.baseAddress, width: image.width, height: image.height,
                                          bitsPerComponent: 8, bytesPerRow: image.width * 4,
                                          space: CGColorSpaceCreateDeviceRGB(),
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            return true
        }
        guard drawn else { return nil }
        pixels = buffer
    }

    func sample(x: Double, y: Double, width: Double, height: Double, size: Int) -> [Double]? {
        guard x >= 0, y >= 0, x + width <= Double(self.width), y + height <= Double(self.height) else { return nil }
        var values: [Double] = []
        values.reserveCapacity(size * size * 3)
        for row in 0..<size {
            let py = Int(y + (Double(row) + 0.5) * height / Double(size))
            for column in 0..<size {
                let px = Int(x + (Double(column) + 0.5) * width / Double(size))
                let index = (py * self.width + px) * 4
                values.append(Double(pixels[index]))
                values.append(Double(pixels[index + 1]))
                values.append(Double(pixels[index + 2]))
            }
        }
        return values
    }

    func thumbnail(x: Int, y: Int, size: Int) -> String? {
        guard x >= 0, y >= 0, x + size <= width, y + size <= height else { return nil }
        var crop = Data(capacity: size * size * 4)
        for row in 0..<size {
            let start = ((y + row) * width + x) * 4
            crop.append(contentsOf: pixels[start..<(start + size * 4)])
        }
        guard let provider = CGDataProvider(data: crop as CFData),
              let image = CGImage(width: size, height: size, bitsPerComponent: 8, bitsPerPixel: 32,
                                  bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                                  provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) else { return nil }
        return NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?.base64EncodedString()
    }
}

// These masks describe the toolbar's smile button and the picker's Favorites
// tab. Score contrast in either direction so the outline works in both themes.
let smile = """
.................
........#........
.....##...##.....
....#.......#....
...#.........#...
..#...#...#...#..
..#..##...##..#..
..#...#...#...#..
.#.............#.
..#..#######..#..
..#..#.....#..#..
..#..##...##..#..
...#...###...#...
....#.......#....
.....##..###.....
........#........
.................
"""
let heart = """
.................
.................
.....##...##.....
...#####.#####...
..##....#....##..
..#...........#..
..#...........#..
..##.........##..
...#.........#...
...##.......##...
....##.....##....
.....##...##.....
......##.##......
.......###.......
.................
.................
.................
"""

func result(_ value: [String: Any]) {
    if let json = try? JSONSerialization.data(withJSONObject: value) { print(String(decoding: json, as: UTF8.self)) }
}

func locateIcon(_ raster: Raster, scaleX: Double, scaleY: Double, mask: String,
                xRange: ClosedRange<Int>, yRange: ClosedRange<Int>, threshold: Double) {
    let stencil = mask.filter { !$0.isWhitespace }.map { $0 == "#" }
    let foreground = Double(stencil.filter { $0 }.count)
    let total = Double(stencil.count)
    let background = total - foreground
    func score(_ x: Int, _ y: Int) -> Double {
        guard let sample = raster.sample(x: (Double(x) - 10) * scaleX, y: (Double(y) - 10) * scaleY,
                                         width: 20 * scaleX, height: 20 * scaleY, size: 17) else { return 0 }
        var on = 0.0, off = 0.0, squared = 0.0
        for (i, marked) in stencil.enumerated() {
            let position = i * 3
            let luma = (sample[position] + sample[position + 1] + sample[position + 2]) / 3
            if marked { on += luma } else { off += luma }
            squared += luma * luma
        }
        let mean = (on + off) / total
        let variance = squared / total - mean * mean
        guard variance >= 64 else { return 0 }
        return abs(on / foreground - off / background) * sqrt(foreground * background) / (total * sqrt(variance))
    }
    var best = (x: xRange.lowerBound, y: yRange.lowerBound, score: 0.0)
    var hits: [(Int, Int, Double)] = []
    for y in yRange {
        for x in xRange {
            let value = score(x, y)
            if value >= threshold { hits.append((x, y, value)) }
            if value > best.score { best = (x, y, value) }
        }
    }
    let duplicate = hits.contains { abs($0.0 - best.x) + abs($0.1 - best.y) >= 8 && $0.2 > best.score - 0.08 }
    guard best.score >= threshold, !duplicate else { result(["found": false]); return }
    result(["found": true, "x": best.x, "y": best.y])
}

func cellPositions(_ raster: Raster, scaleX: Double, scaleY: Double, heartX: Int, heartY: Int) -> [(Int, Int)] {
    let left = heartX - 77
    let top = heartY - 435
    let bottom = heartY - 27
    let columns = (0..<5).map { left + $0 * 88 }
    guard top >= 0, let background = raster.sample(x: Double(left - 43) * scaleX, y: Double(heartY - 32) * scaleY,
                                                    width: 1, height: 1, size: 1) else { return [] }
    func ink(_ sample: [Double]) -> Int {
        var count = 0
        for index in stride(from: 0, to: sample.count, by: 3) {
            if (0..<3).contains(where: { abs(sample[index + $0] - background[$0]) > 36 }) { count += 1 }
        }
        return count
    }
    var bands: [(first: Int, last: Int)] = []
    for y in top..<bottom {
        let marked = columns.contains { x in
            guard let line = raster.sample(x: Double(x - 33) * scaleX, y: Double(y) * scaleY,
                                           width: 66 * scaleX, height: 1, size: 8) else { return false }
            return ink(line) >= 8
        }
        guard marked else { continue }
        if let last = bands.last, y - last.last < 14 { bands[bands.count - 1].last = y }
        else { bands.append((y, y)) }
    }
    let rows = bands.compactMap { band -> Int? in
        guard band.last - band.first >= 20, band.last - band.first <= 84,
              band.first > top + 2, band.last < bottom - 3 else { return nil }
        let center = (band.first + band.last) / 2
        let firstCenter = heartY - 386
        let aligned = firstCenter + Int((Double(center - firstCenter) / 88).rounded()) * 88
        return abs(center - aligned) <= 8 ? aligned : center
    }
    return rows.flatMap { y in columns.compactMap { x -> (Int, Int)? in
        guard let sample = raster.sample(x: Double(x - 24) * scaleX, y: Double(y - 24) * scaleY,
                                         width: 48 * scaleX, height: 48 * scaleY, size: 9), ink(sample) >= 8 else { return nil }
        return (x, y)
    } }
}

func stickerRaster(_ raster: Raster, scaleX: Double, scaleY: Double, x: Int, y: Int, size: Int) -> [Double]? {
    return raster.sample(x: Double(x - 26) * scaleX, y: Double(y - 26) * scaleY,
                         width: 52 * scaleX, height: 52 * scaleY, size: size)
}

func visualKey(_ sample: [Double]) -> String {
    return Data(sample.map { UInt8($0.rounded()) }).base64EncodedString()
}

func scanGrid(_ raster: Raster, scaleX: Double, scaleY: Double, heartX: Int, heartY: Int) {
    let cells: [[String: Any]] = cellPositions(raster, scaleX: scaleX, scaleY: scaleY, heartX: heartX, heartY: heartY)
        .compactMap { x, y in
            let side = Int((52 * scaleX).rounded())
            guard let image = raster.thumbnail(x: Int(Double(x - 26) * scaleX), y: Int(Double(y - 26) * scaleY), size: side),
                  let sample = stickerRaster(raster, scaleX: scaleX, scaleY: scaleY, x: x, y: y, size: 10),
                  let detail = stickerRaster(raster, scaleX: scaleX, scaleY: scaleY, x: x, y: y, size: 24) else { return nil }
            return ["image": image, "signature": sample.map { Int($0.rounded()) },
                    "visual": visualKey(detail), "x": x, "y": y]
        }
    result(["cells": cells])
}

func locateSticker(_ raster: Raster, scaleX: Double, scaleY: Double, reference: Raster, heartX: Int, heartY: Int) {
    let size = 15
    guard let template = reference.sample(x: 0, y: 0, width: Double(reference.width),
                                          height: Double(reference.height), size: size) else { return }
    var cells = cellPositions(raster, scaleX: scaleX, scaleY: scaleY, heartX: heartX, heartY: heartY).map { (x, y) in
        var best = (x: x, y: y, error: Double.infinity)
        for offsetY in -5...5 {
            for offsetX in -5...5 {
                guard let sample = stickerRaster(raster, scaleX: scaleX, scaleY: scaleY,
                                                 x: x + offsetX, y: y + offsetY, size: size) else { continue }
                let error = zip(sample, template).reduce(0.0) { $0 + abs($1.0 - $1.1) } / Double(template.count)
                if error < best.error { best = (x, y, error) }
            }
        }
        return best
    }
    cells.sort { $0.error < $1.error }
    guard let best = cells.first, best.error <= 20, (cells.dropFirst().first?.error ?? .infinity) - best.error >= 10 else {
        result(["found": false]); return
    }
    result(["found": true, "x": best.x, "y": best.y])
}

func attribute<T>(_ target: AXUIElement, _ name: String) -> T? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(target, name as CFString, &value) == .success else { return nil }
    return value as? T
}

func frameOf(_ row: [String: Any]) -> CGRect? {
    guard let bounds = row[kCGWindowBounds as String] as? NSDictionary else { return nil }
    return CGRect(dictionaryRepresentation: bounds)
}

func interactIfWeChatIsFront(windowID: Int, frame: CGRect, point: CGPoint, title: String, scroll: Int32?) {
    guard let app = NSWorkspace.shared.frontmostApplication, app.bundleIdentifier == "com.tencent.xinWeChat",
          let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
          let window = rows.first(where: { ($0[kCGWindowNumber as String] as? Int) == windowID }),
          (window[kCGWindowOwnerPID as String] as? pid_t) == app.processIdentifier, frameOf(window) == frame,
          frame.contains(point),
          let front = rows.first(where: { ($0[kCGWindowLayer as String] as? Int) == 0 && frameOf($0)?.contains(point) == true }),
          (front[kCGWindowOwnerPID as String] as? pid_t) == app.processIdentifier,
          let main: AXUIElement = attribute(AXUIElementCreateApplication(app.processIdentifier), kAXMainWindowAttribute),
          let location: AXValue = attribute(main, kAXPositionAttribute),
          let nativeTitle: String = attribute(main, kAXTitleAttribute), nativeTitle.trimmingCharacters(in: .whitespacesAndNewlines) == title else {
        result(["acted": false]); return
    }
    var origin = CGPoint.zero
    guard AXValueGetValue(location, .cgPoint, &origin), origin == frame.origin else { result(["acted": false]); return }
    if let scroll {
        guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: scroll, wheel2: 0, wheel3: 0) else {
            result(["acted": false]); return
        }
        CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
        event.location = point
        event.post(tap: .cghidEventTap)
        result(["acted": true]); return
    }
    guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
          let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
        result(["acted": false]); return
    }
    down.post(tap: .cghidEventTap)
    usleep(40_000)
    up.post(tap: .cghidEventTap)
    result(["acted": true])
}

let args = Array(CommandLine.arguments.dropFirst())
guard let mode = args.first else { exit(2) }
if mode == "fingerprints" {
    guard args.count == 2, let data = try? Data(contentsOf: URL(fileURLWithPath: args[1])),
          let images = try? JSONDecoder().decode([String: String].self, from: data) else { exit(2) }
    let keys = images.compactMapValues { path -> String? in
        guard let raster = Raster(path), let detail = raster.sample(x: 0, y: 0,
            width: Double(raster.width), height: Double(raster.height), size: 24) else { return nil }
        return visualKey(detail)
    }
    result(keys)
} else if mode == "click" || mode == "scroll" {
    guard args.count == (mode == "click" ? 9 : 10), let id = Int(args[1]), let x = Double(args[2]), let y = Double(args[3]),
          let width = Double(args[4]), let height = Double(args[5]),
          let clickX = Double(args[6]), let clickY = Double(args[7]) else { exit(2) }
    let scroll = mode == "scroll" ? Int32(args[9]) : nil
    if mode == "scroll", scroll == nil { exit(2) }
    interactIfWeChatIsFront(windowID: id, frame: CGRect(x: x, y: y, width: width, height: height),
                           point: CGPoint(x: clickX, y: clickY), title: args[8], scroll: scroll)
} else {
    guard args.count >= 4, let raster = Raster(args[1]),
          let width = Double(args[2]), let height = Double(args[3]), width > 0, height > 0 else { exit(2) }
    let scaleX = Double(raster.width) / width, scaleY = Double(raster.height) / height
    switch mode {
    case "toolbar", "favorites":
        guard args.count == 8, let left = Int(args[4]), let right = Int(args[5]), left <= right,
              let top = Int(args[6]), let bottom = Int(args[7]), top <= bottom else { exit(2) }
        locateIcon(raster, scaleX: scaleX, scaleY: scaleY, mask: mode == "toolbar" ? smile : heart,
                   xRange: left...right, yRange: top...bottom, threshold: mode == "toolbar" ? 0.70 : 0.66)
    case "sticker":
        guard args.count == 7, let reference = Raster(args[4]),
              let x = Int(args[5]), let y = Int(args[6]) else { exit(2) }
        locateSticker(raster, scaleX: scaleX, scaleY: scaleY, reference: reference, heartX: x, heartY: y)
    case "grid":
        guard args.count == 6, let x = Int(args[4]), let y = Int(args[5]) else { exit(2) }
        scanGrid(raster, scaleX: scaleX, scaleY: scaleY, heartX: x, heartY: y)
    default: exit(2)
    }
}
