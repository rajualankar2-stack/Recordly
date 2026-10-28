import Foundation
import CoreGraphics

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
    // CGEvent locations are global points with a top-left origin, the same space cursor-log.py
    // logs in. (Flipping NSEvent.mouseLocation by NSScreen.main's height breaks on multi-monitor
    // setups, since NSScreen.main is the key window's screen, not the primary one.)
    if down && !prev, let loc = CGEvent(source: nil)?.location {
        let t = ProcessInfo.processInfo.systemUptime - start
        let line = String(format: "{\"t\":%.6f,\"x\":%.2f,\"y\":%.2f}\n", t, loc.x, loc.y)
        if let data = line.data(using: .utf8) { fh.write(data) }
    }
    prev = down
    Thread.sleep(forTimeInterval: 1.0/120.0)
}
