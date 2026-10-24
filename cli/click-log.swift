import Foundation
import CoreGraphics
import AppKit

guard CommandLine.arguments.count >= 2 else {
    fputs("usage: click-log <outpath>\n", stderr)
    exit(1)
}
let outPath = CommandLine.arguments[1]
guard FileManager.default.createFile(atPath: outPath, contents: nil) else { exit(1) }
guard let fh = FileHandle(forWritingAtPath: outPath) else { exit(1) }

let start = ProcessInfo.processInfo.systemUptime
var prev = false

while true {
    let down = CGEventSource.buttonState(.combinedSessionState, button: .left)
    if down && !prev {
        let mouseLoc = NSEvent.mouseLocation
        let screenH = NSScreen.main?.frame.height ?? 0
        let x = mouseLoc.x
        let y = screenH - mouseLoc.y
        let t = ProcessInfo.processInfo.systemUptime - start
        let line = String(format: "{\"t\":%.6f,\"x\":%.2f,\"y\":%.2f}\n", t, x, y)
        if let data = line.data(using: .utf8) { fh.write(data) }
    }
    prev = down
    Thread.sleep(forTimeInterval: 1.0/120.0)
}
