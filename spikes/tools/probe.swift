// probe: diagnostics for the §12 spikes (throwaway tool, not shipped). JSON-lines output.
//
//   probe perms                                  preflight permission booleans (never prompts)
//   probe levels [--all]                         every on-screen window, front-to-back; --all adds
//                                                windows on other Spaces (e.g. a fullscreen app's)
//   probe screens                                each display: CG bounds, camera-housing inset, visible frame
//   probe winpos --wid W [--hz 250] [--seconds S] sample one window's bounds on a precise timer
//   probe hit --x X --y Y                        what is under a point (global points, y down)
//   probe frontmost                              the frontmost app
//   probe responsible --pid P                    which process TCC attributes P's permissions to
//
// Privacy: never reads window titles (only owner names, which are app names), never prompts for
// a permission, never captures the screen. Build: bash spikes/tools/build-tools.sh

import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation

// MARK: - Output helpers

func jsonString(_ value: String?) -> String {
    guard let value else { return "null" }
    var out = "\""
    for scalar in value.unicodeScalars {
        switch scalar {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if scalar.value < 0x20 {
                out += String(format: "\\u%04x", scalar.value)
            } else {
                out.unicodeScalars.append(scalar)
            }
        }
    }
    return out + "\""
}

func jsonNumber(_ value: Double?) -> String {
    guard let value, value.isFinite else { return "null" }
    if value == value.rounded(), abs(value) < 9.0e15 { return String(Int64(value)) }
    return String(value)
}

func jsonInt<T: BinaryInteger>(_ value: T?) -> String {
    guard let value else { return "null" }
    return String(value)
}

/// Builds `{"k":v,...}` from already-encoded values, keeping key order.
func object(_ fields: [(String, String)]) -> String {
    "{" + fields.map { "\"\($0.0)\":\($0.1)" }.joined(separator: ",") + "}"
}

func emit(_ line: String) {
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("probe: \(message)\n".utf8))
    exit(2)
}

func option(_ name: String, in arguments: [String]) -> String? {
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}

func numberOption(_ name: String, in arguments: [String], default fallback: Double? = nil) -> Double {
    if let text = option(name, in: arguments) {
        guard let value = Double(text), value.isFinite else { fail("\(name) needs a number") }
        return value
    }
    guard let fallback else { fail("missing \(name)") }
    return fallback
}

// MARK: - Shared queries

struct WindowInfo {
    let wid: Int64
    let pid: pid_t
    let owner: String?
    let layer: Int64
    let frame: CGRect
    let alpha: Double
    let onScreen: Bool
}

/// Reads only the window number, owner PID, owner (app) name, layer, bounds, alpha and on-screen
/// flag. The title entry is never accessed.
func windows(_ options: CGWindowListOption, relativeTo wid: CGWindowID = kCGNullWindowID) -> [WindowInfo] {
    guard let raw = CGWindowListCopyWindowInfo(options, wid) else { return [] }
    var result: [WindowInfo] = []
    for case let info as NSDictionary in raw as NSArray {
        guard let number = info[kCGWindowNumber] as? NSNumber,
              let pid = info[kCGWindowOwnerPID] as? NSNumber,
              let boundsInfo = info[kCGWindowBounds] as? NSDictionary,
              let frame = CGRect(dictionaryRepresentation: boundsInfo as CFDictionary)
        else { continue }
        result.append(WindowInfo(
            wid: number.int64Value,
            pid: pid.int32Value,
            owner: info[kCGWindowOwnerName] as? String,
            layer: (info[kCGWindowLayer] as? NSNumber)?.int64Value ?? 0,
            frame: frame,
            alpha: (info[kCGWindowAlpha] as? NSNumber)?.doubleValue ?? 1,
            onScreen: (info[kCGWindowIsOnscreen] as? NSNumber)?.boolValue ?? false
        ))
    }
    return result
}

var bundleIdCache: [pid_t: String?] = [:]
func bundleId(of pid: pid_t) -> String? {
    if let cached = bundleIdCache[pid] { return cached }
    let value = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
    bundleIdCache[pid] = value
    return value
}

typealias ResponsibilityFunction = @convention(c) (pid_t) -> pid_t
func responsiblePid(of pid: pid_t) -> pid_t? {
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid") else { return nil }
    let value = unsafeBitCast(symbol, to: ResponsibilityFunction.self)(pid)
    return value > 0 ? value : nil
}

func executablePath(of pid: pid_t) -> String? {
    var buffer = [UInt8](repeating: 0, count: 4 * Int(MAXPATHLEN))
    let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
    guard length > 0 else { return nil }
    return String(decoding: buffer.prefix(Int(length)), as: UTF8.self)
}

func monotonicSeconds() -> Double {
    Double(clock_gettime_nsec_np(CLOCK_UPTIME_RAW)) / 1e9
}

// MARK: - Subcommands

func perms() {
    emit(object([
        ("listen", String(CGPreflightListenEventAccess())),
        ("post", String(CGPreflightPostEventAccess())),
        ("accessibility", String(AXIsProcessTrusted())),
        ("screenCapture", String(CGPreflightScreenCaptureAccess())),
    ]))
}

func levels(_ arguments: [String]) {
    let all = arguments.contains("--all")
    for window in windows(all ? [.optionAll] : [.optionOnScreenOnly]) {
        emit(object([
            ("wid", jsonInt(window.wid)),
            ("pid", jsonInt(window.pid)),
            ("owner", jsonString(window.owner)),
            ("bundleId", jsonString(bundleId(of: window.pid))),
            ("layer", jsonInt(window.layer)),
            ("x", jsonNumber(window.frame.origin.x)),
            ("y", jsonNumber(window.frame.origin.y)),
            ("w", jsonNumber(window.frame.size.width)),
            ("h", jsonNumber(window.frame.size.height)),
            ("alpha", jsonNumber(window.alpha)),
            ("onScreen", String(window.onScreen)),
        ]))
    }
}

/// Per display: CG bounds (global points, y down), whether it is built in, and NSScreen's
/// camera-housing inset and visible frame converted to the same space. This is what the helper's
/// fullscreen test compares windows against (full bounds, or the area below the housing).
func screens() {
    let mainHeight = Double(CGDisplayBounds(CGMainDisplayID()).height)
    let key = NSDeviceDescriptionKey("NSScreenNumber")
    var byId: [CGDirectDisplayID: NSScreen] = [:]
    for screen in NSScreen.screens {
        if let number = screen.deviceDescription[key] as? NSNumber { byId[number.uint32Value] = screen }
    }
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success else { fail("CGGetActiveDisplayList failed") }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetActiveDisplayList(count, &ids, &count) == .success else { fail("CGGetActiveDisplayList failed") }
    func rect(_ r: CGRect) -> String {
        object([("x", jsonNumber(r.origin.x)), ("y", jsonNumber(r.origin.y)), ("w", jsonNumber(r.size.width)), ("h", jsonNumber(r.size.height))])
    }
    for id in ids.prefix(Int(count)) {
        let bounds = CGDisplayBounds(id)
        let screen = byId[id]
        // Cocoa frames have a bottom-left origin on the main display; flip to top-left, y down.
        let visible = screen.map { frame -> CGRect in
            let v = frame.visibleFrame
            return CGRect(x: v.origin.x, y: mainHeight - (v.origin.y + v.size.height), width: v.size.width, height: v.size.height)
        }
        let inset = screen.map { Double($0.safeAreaInsets.top) }
        emit(object([
            ("id", jsonInt(id)),
            ("bounds", rect(bounds)),
            ("main", String(id == CGMainDisplayID())),
            ("builtin", String(CGDisplayIsBuiltin(id) != 0)),
            ("safeAreaTop", jsonNumber(inset)),
            ("belowHousing", inset.map { rect(CGRect(x: bounds.minX, y: bounds.minY + $0, width: bounds.width, height: bounds.height - $0)) } ?? "null"),
            ("visibleFrame", visible.map(rect) ?? "null"),
            ("nsScreenSizeMatches", screen.map { String($0.frame.size == bounds.size) } ?? "null"),
        ]))
    }
}

struct Sample {
    let t: Double
    let frame: CGRect?
    let onScreen: Bool
}

/// Samples one window's bounds on a strict, zero-leeway timer. Lines are buffered in memory and
/// written at the end (or on SIGINT/SIGTERM) so printing never perturbs the sampling cadence.
/// `t` is the midpoint of each window-server query, in seconds since the probe started.
func winpos(_ arguments: [String]) {
    let wid = numberOption("--wid", in: arguments)
    let hz = numberOption("--hz", in: arguments, default: 250)
    let seconds = numberOption("--seconds", in: arguments, default: 5)
    guard wid > 0, wid <= Double(UInt32.max) else { fail("--wid must be a window number") }
    guard hz > 0, hz <= 2000 else { fail("--hz must be in (0, 2000]") }
    guard seconds > 0 else { fail("--seconds must be > 0") }

    let windowId = CGWindowID(wid)
    let total = Int((hz * seconds).rounded())
    // The first window-server query sets up the connection (~20-35 ms); keep it out of the stats.
    _ = windows(.optionIncludingWindow, relativeTo: windowId)
    let start = monotonicSeconds()
    var samples: [Sample] = []
    samples.reserveCapacity(total)

    let queue = DispatchQueue(label: "probe.winpos", qos: .userInteractive)
    let timer = DispatchSource.makeTimerSource(flags: .strict, queue: queue)
    let done = DispatchSemaphore(value: 0)
    timer.schedule(deadline: .now(), repeating: 1.0 / hz, leeway: .nanoseconds(0))
    timer.setEventHandler {
        autoreleasepool {
            let before = monotonicSeconds()
            let match = windows(.optionIncludingWindow, relativeTo: windowId).first { $0.wid == Int64(windowId) }
            let after = monotonicSeconds()
            samples.append(Sample(t: (before + after) / 2 - start, frame: match?.frame, onScreen: match?.onScreen ?? false))
        }
        if samples.count >= total {
            timer.cancel()
            done.signal()
        }
    }

    func finish() -> Never {
        var text = ""
        text.reserveCapacity(samples.count * 80)
        var maxInterval = 0.0
        for (index, sample) in samples.enumerated() {
            if index > 0 { maxInterval = max(maxInterval, sample.t - samples[index - 1].t) }
            text += object([
                ("t", String(format: "%.6f", sample.t)),
                ("x", jsonNumber(sample.frame.map { Double($0.origin.x) })),
                ("y", jsonNumber(sample.frame.map { Double($0.origin.y) })),
                ("w", jsonNumber(sample.frame.map { Double($0.size.width) })),
                ("h", jsonNumber(sample.frame.map { Double($0.size.height) })),
                ("onScreen", String(sample.onScreen)),
            ]) + "\n"
        }
        let span = samples.count > 1 ? (samples[samples.count - 1].t - samples[0].t) : 0
        let mean = samples.count > 1 ? span / Double(samples.count - 1) : 0
        text += object([("summary", object([
            ("samples", jsonInt(samples.count)),
            ("meanIntervalMs", String(format: "%.4f", mean * 1000)),
            ("maxIntervalMs", String(format: "%.4f", maxInterval * 1000)),
        ]))]) + "\n"
        FileHandle.standardOutput.write(Data(text.utf8))
        exit(0)
    }

    // Stop early on Ctrl-C / kill and still print what was collected.
    var signalSources: [DispatchSourceSignal] = []
    for sig in [SIGINT, SIGTERM] {
        signal(sig, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: sig, queue: queue)
        source.setEventHandler {
            timer.cancel()
            done.signal()
        }
        source.resume()
        signalSources.append(source)
    }

    timer.resume()
    done.wait()
    queue.sync { finish() }
}

func hit(_ arguments: [String]) {
    let x = numberOption("--x", in: arguments)
    let y = numberOption("--y", in: arguments)
    // NSWindow.windowNumber(at:) returns 0 until NSApplication exists. Prohibited policy: no Dock
    // icon, never activates, nothing is shown.
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    // Cocoa screen coordinates have their origin at the bottom-left of the main display.
    let mainHeight = CGDisplayBounds(CGMainDisplayID()).height
    let nsWindowNumber = NSWindow.windowNumber(at: NSPoint(x: x, y: Double(mainHeight) - y), belowWindowWithWindowNumber: 0)
    let point = CGPoint(x: x, y: y)
    let top = windows([.optionOnScreenOnly]).first { $0.frame.contains(point) }
    let topJSON = top.map {
        object([
            ("wid", jsonInt($0.wid)),
            ("layer", jsonInt($0.layer)),
            ("owner", jsonString($0.owner)),
            ("pid", jsonInt($0.pid)),
            ("alpha", jsonNumber($0.alpha)),
        ])
    } ?? "null"
    emit(object([("nsWindowNumberAt", jsonInt(nsWindowNumber)), ("topCGWindowAt", topJSON)]))
}

func frontmost() {
    let app = NSWorkspace.shared.frontmostApplication
    emit(object([
        ("bundleId", jsonString(app?.bundleIdentifier)),
        ("pid", jsonInt(app?.processIdentifier)),
        ("appName", jsonString(app?.localizedName)),
    ]))
}

func responsible(_ arguments: [String]) {
    let value = numberOption("--pid", in: arguments)
    guard value > 0, value <= Double(Int32.max) else { fail("--pid must be a process id") }
    let pid = pid_t(value)
    let owner = responsiblePid(of: pid)
    emit(object([
        ("pid", jsonInt(pid)),
        ("responsiblePid", jsonInt(owner)),
        ("responsiblePath", jsonString(owner.flatMap(executablePath(of:)))),
    ]))
}

// MARK: - Main

let arguments = Array(CommandLine.arguments.dropFirst())
switch arguments.first {
case "perms": perms()
case "levels": levels(arguments)
case "screens": screens()
case "winpos": winpos(arguments)
case "hit": hit(arguments)
case "frontmost": frontmost()
case "responsible": responsible(arguments)
default:
    fail("usage: probe perms | levels [--all] | screens | winpos --wid W [--hz 250] [--seconds 5] | hit --x X --y Y | frontmost | responsible --pid P")
}
