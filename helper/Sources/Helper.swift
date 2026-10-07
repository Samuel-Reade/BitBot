// bitbot-helper: Bitbot's window / app sidecar (BITBOT_SPEC.md §5.3), plus global input capture.
// SPEC-DEVIATION: §3, §7.1 and §10.4 assign global input to uiohook-napi. uiohook-napi needs
// Accessibility, installs an active event tap and translates key presses to text, so input capture
// is proposed here instead: a listen-only tap that needs only Input Monitoring and never sees
// characters (docs/decisions/input-and-helper.md). Pending the user's approval; until then the
// tap is only used by the Spike B harness.
//
// This file holds everything except process startup (helper/Sources/main.swift), so the Swift unit
// tests (helper/Tests, run by helper/test-helper.sh) can compile it on its own.
//
// Wire protocol: newline-delimited JSON. Commands arrive on stdin; replies and events leave on
// stdout, exactly one JSON object per line, written whole and unbuffered. The authoritative
// TypeScript definitions are in src/main/helper/protocol.ts; keep both in sync with
// `protocolVersion` below.
//
// Privacy (BITBOT_SPEC.md §2.1):
//  - Window titles are never read. Only the window number, owner PID, layer, bounds, on-screen flag
//    and alpha entries of the window list are accessed; the title entry is never touched.
//  - Key codes are forwarded to the parent transiently for anti-gaming (§7.3). They are never
//    translated to characters, never logged, and never written anywhere except the stdout pipe.
//  - No networking of any kind.
//  - Nothing here shows a permission prompt except requestInputAccess (onboarding, §15.1).
//
// Threads:
//  - main: CFRunLoop (NSWorkspace notifications need it), command handling, timers, snapshots.
//  - stdin reader: blocking reads; hands complete lines to main.
//  - permissions (GCD, utility QoS): the TCC queries of inputAccess / requestInputAccess, which take
//    10-40 ms each and would otherwise stall snapshot pushes.
//  - input tap (only while a tap is active): its own CFRunLoop, so a busy main thread never delays
//    or drops input events.
// Every stdout write goes through one locked writer, so lines never interleave.

import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation

// MARK: - Limits

// SPEC-DEVIATION: §17 keeps tunable numbers in src/shared/tuning.ts. The helper's behaviour numbers
// do come from there (tuning.helper, handed over as command-line flags; see HelperSettings). The
// constants below stay in the binary because they are protocol and safety limits that must hold
// even when a buggy or foreign client drives it, not behaviour; the client applies its own, tighter
// limits from tuning.helper. The waits below (tap-thread stop, exit grace, stdout back-pressure)
// and the timer leeways in Poller and FullscreenMonitor are likewise implementation details
// (shutdown safety, wakeup coalescing), not behaviour.
let protocolVersion = 2
/// Longest accepted command line (bytes). Commands are tiny; anything longer is corrupt input.
let maxCommandBytes = 64 * 1024
/// setPollRate is clamped to this range (Hz). The client clamps lower (tuning.helper.maxPollHz).
let maxPollHz = 60.0
let minPollHz = 0.01
/// Input-event timestamps older than this (s) are implausible; fall back to the receipt time.
let maxPlausibleEventAge = 10.0
/// How long stop() waits for the input-tap thread to finish (s) before giving up on it.
let tapThreadStopTimeout = 1.0
/// After stdin closes (parent gone): grace for main to finish before a hard exit (s).
let parentGoneExitGraceSeconds: UInt32 = 2
/// While stdout is full: how long one poll() waits for the parent to drain it (ms).
let stdoutFullPollMs: Int32 = 1000
/// The bundle-id cache is pruned only above max(this, 2 × visible windows) entries.
let appCacheMinimumEntries = 64

// MARK: - Settings

/// Behaviour numbers. The client passes them from tuning.helper (src/shared/tuning.ts) as flags;
/// these defaults only apply when the binary runs on its own.
struct HelperSettings: Equatable {
    /// --fullscreen-idle-hz: fullscreen re-check cadence while snapshot polling is off or slower.
    ///
    /// Why 1 Hz: one check is one window-server query, ~0.3 ms of CPU from an idle wakeup with ~15
    /// windows (measured on an M4; the whole helper idles at ~0.06% of a core with this timer).
    /// Native fullscreen changes the active Space, and app activation is observed directly, so both
    /// trigger immediate checks; the cadence only bounds the detection latency for same-Space
    /// ("non-native") fullscreen windows, which is fine at <= 1 s against a 300 ms fade (§8.6).
    var fullscreenIdleHz = 1.0
    /// --fullscreen-tolerance-pt: a window "covers" a display when its bounds match within this.
    var fullscreenTolerance: CGFloat = 1
    /// --fullscreen-follow-up-ms: after an app activation or Space change, re-check fullscreen once
    /// more after this delay (s): a native fullscreen transition animates for ~0.7 s, so the
    /// immediate check can see the old layout. 0 disables the follow-up.
    var fullscreenFollowUpDelay = 0.6
    /// --resync-ms: safety-net re-reads (s) of state that notifications normally keep current: the
    /// frontmost app (activation notifications) and display bounds (reconfiguration callback). Each
    /// re-read is one to three IPC round trips, so the per-tick fullscreen check stays free of them.
    var resyncInterval = 5.0
}

/// Set once by main.swift from the command line, before anything else runs.
var settings = HelperSettings()

struct ParsedArguments {
    var settings = HelperSettings()
    var printVersion = false
    /// One line per ignored argument, for stderr.
    var diagnostics: [String] = []
}

/// Parses `--name=value` flags. Invalid or unknown ones are reported and ignored (defaults stay).
func parseArguments(_ arguments: [String]) -> ParsedArguments {
    var result = ParsedArguments()
    for argument in arguments {
        if argument == "--version" {
            result.printVersion = true
            continue
        }
        guard argument.hasPrefix("--"), let equals = argument.firstIndex(of: "=") else {
            result.diagnostics.append("ignoring unknown argument \(argument.prefix(64))")
            continue
        }
        let name = String(argument[..<equals])
        let value = Double(argument[argument.index(after: equals)...])
        func valid(_ range: ClosedRange<Double>) -> Double? {
            guard let value, value.isFinite, range.contains(value) else {
                result.diagnostics.append("ignoring invalid \(name) value")
                return nil
            }
            return value
        }
        switch name {
        case "--fullscreen-idle-hz":
            if let hz = valid(0...maxPollHz) { result.settings.fullscreenIdleHz = hz }
        case "--fullscreen-tolerance-pt":
            if let points = valid(0...64) { result.settings.fullscreenTolerance = CGFloat(points) }
        case "--fullscreen-follow-up-ms":
            if let ms = valid(0...10_000) { result.settings.fullscreenFollowUpDelay = ms / 1000 }
        case "--resync-ms":
            if let ms = valid(250...600_000) { result.settings.resyncInterval = ms / 1000 }
        default:
            result.diagnostics.append("ignoring unknown option \(name.prefix(64))")
        }
    }
    return result
}

// MARK: - Output

/// Serializes whole-line writes to stdout from any thread. Exits quietly when the parent is gone.
final class LineWriter {
    private let lock = NSLock()

    func send(_ line: String) {
        var text = line
        text.append("\n")
        lock.lock()
        defer { lock.unlock() }
        text.withUTF8 { buffer in
            guard var cursor = buffer.baseAddress else { return }
            var remaining = buffer.count
            while remaining > 0 {
                let written = Darwin.write(STDOUT_FILENO, cursor, remaining)
                if written > 0 {
                    cursor += written
                    remaining -= written
                } else if written < 0 && errno == EINTR {
                    continue
                } else if written < 0 && errno == EAGAIN {
                    var pfd = pollfd(fd: STDOUT_FILENO, events: Int16(POLLOUT), revents: 0)
                    _ = poll(&pfd, 1, stdoutFullPollMs)
                } else {
                    // EPIPE or another hard error: the parent stopped listening. Nothing to clean up.
                    _exit(0)
                }
            }
        }
    }
}

let output = LineWriter()

/// Rare operational diagnostics only. Never pass anything derived from input events.
func logDiagnostic(_ message: String) {
    let line = "bitbot-helper: \(message)\n"
    line.utf8CString.withUnsafeBufferPointer { buffer in
        _ = Darwin.write(STDERR_FILENO, buffer.baseAddress, buffer.count - 1)
    }
}

// MARK: - JSON encoding

func appendJSONString(_ value: String?, to out: inout String) {
    guard let value else {
        out.append("null")
        return
    }
    out.append("\"")
    // Fast path: nothing to escape (bundle ids and app names almost never need it).
    if !value.utf8.contains(where: { $0 < 0x20 || $0 == 0x22 || $0 == 0x5C }) {
        out.append(value)
        out.append("\"")
        return
    }
    for scalar in value.unicodeScalars {
        switch scalar {
        case "\"": out.append("\\\"")
        case "\\": out.append("\\\\")
        case "\n": out.append("\\n")
        case "\r": out.append("\\r")
        case "\t": out.append("\\t")
        default:
            if scalar.value < 0x20 {
                out.append("\\u00")
                out.append(scalar.value < 0x10 ? "0" : "1")
                out.append(String(scalar.value & 0xF, radix: 16))
            } else {
                out.unicodeScalars.append(scalar)
            }
        }
    }
    out.append("\"")
}

/// Integral values print without a fraction; others use Swift's shortest round-trip form, which
/// is valid JSON for every finite Double. Non-finite values become null (the parser then rejects
/// the message rather than accepting a fabricated number).
func appendJSONNumber(_ value: Double, to out: inout String) {
    guard value.isFinite else {
        out.append("null")
        return
    }
    if value == value.rounded(), abs(value) < 9.0e15 {
        out.append(String(Int64(value)))
    } else {
        out.append(String(value))
    }
}

/// Builds one flat JSON object. Keys are trusted literals and are not escaped.
struct JSONObject {
    private(set) var text: String
    private var empty = true

    init(capacity: Int = 160) {
        text = String()
        text.reserveCapacity(capacity)
        text.append("{")
    }

    private mutating func key(_ name: String) {
        if empty { empty = false } else { text.append(",") }
        text.append("\"")
        text.append(name)
        text.append("\":")
    }

    mutating func string(_ name: String, _ value: String?) {
        key(name)
        appendJSONString(value, to: &text)
    }

    mutating func int(_ name: String, _ value: Int64?) {
        key(name)
        if let value { text.append(String(value)) } else { text.append("null") }
    }

    mutating func number(_ name: String, _ value: Double) {
        key(name)
        appendJSONNumber(value, to: &text)
    }

    mutating func bool(_ name: String, _ value: Bool) {
        key(name)
        text.append(value ? "true" : "false")
    }

    /// `json` must already be valid JSON (an array or object built by this file).
    mutating func raw(_ name: String, _ json: String) {
        key(name)
        text.append(json)
    }

    mutating func finish() -> String {
        text.append("}")
        return text
    }
}

func unixNow() -> Double {
    Date().timeIntervalSince1970
}

/// Seconds on the monotonic uptime clock (for intervals; not wall time).
func monotonicNow() -> Double {
    Double(clock_gettime_nsec_np(CLOCK_UPTIME_RAW)) / 1e9
}

func sendError(id: Int64?, _ message: String) {
    var json = JSONObject()
    json.string("type", "error")
    json.int("id", id)
    json.string("message", message)
    output.send(json.finish())
}

// MARK: - Command parsing

enum Command: Equatable {
    case snapshot(id: Int64)
    case setPollRate(hz: Double)
    case ping(id: Int64)
    case displays(id: Int64)
    case frontmost(id: Int64)
    case appInfo(id: Int64, pid: pid_t)
    case inputAccess(id: Int64)
    case requestInputAccess(id: Int64)
    case startInputTap(id: Int64, keys: Bool, mouse: Bool)
    case stopInputTap(id: Int64)
    case diag(id: Int64)
    case fullscreenState(id: Int64)
    case quit
}

enum ParsedLine: Equatable {
    case command(Command)
    case invalid(id: Int64?, message: String)
}

func isJSONBool(_ value: Any?) -> Bool {
    guard let number = value as? NSNumber else { return false }
    return CFGetTypeID(number) == CFBooleanGetTypeID()
}

func jsonBool(_ value: Any?) -> Bool? {
    isJSONBool(value) ? (value as? NSNumber)?.boolValue : nil
}

func jsonNumber(_ value: Any?) -> Double? {
    guard let number = value as? NSNumber, !isJSONBool(number) else { return nil }
    let double = number.doubleValue
    return double.isFinite ? double : nil
}

func jsonInteger(_ value: Any?) -> Int64? {
    guard let double = jsonNumber(value), double == double.rounded(), abs(double) <= 9_007_199_254_740_991 else {
        return nil
    }
    return Int64(double)
}

func parseCommand(_ data: Data) -> ParsedLine {
    guard let object = (try? JSONSerialization.jsonObject(with: data)) as? NSDictionary else {
        return .invalid(id: nil, message: "malformed command: not a JSON object")
    }
    let id = jsonInteger(object["id"])
    guard let type = object["type"] as? String else {
        return .invalid(id: id, message: "malformed command: missing \"type\"")
    }
    let shownType = type.count > 64 ? String(type.prefix(64)) + "…" : type

    // Every command except setPollRate and quit is a request and must carry an integer id.
    func request(_ make: (Int64) -> Command?) -> ParsedLine {
        guard let id else { return .invalid(id: nil, message: "\(shownType): missing or non-integer \"id\"") }
        guard let command = make(id) else { return .invalid(id: id, message: "\(shownType): invalid arguments") }
        return .command(command)
    }

    switch type {
    case "snapshot": return request { .snapshot(id: $0) }
    case "ping": return request { .ping(id: $0) }
    case "displays": return request { .displays(id: $0) }
    case "frontmost": return request { .frontmost(id: $0) }
    case "inputAccess": return request { .inputAccess(id: $0) }
    case "requestInputAccess": return request { .requestInputAccess(id: $0) }
    case "stopInputTap": return request { .stopInputTap(id: $0) }
    case "diag": return request { .diag(id: $0) }
    case "fullscreenState": return request { .fullscreenState(id: $0) }
    case "appInfo":
        return request { id in
            guard let pid = jsonInteger(object["pid"]), pid > 0, pid <= Int64(Int32.max) else { return nil }
            return .appInfo(id: id, pid: pid_t(pid))
        }
    case "startInputTap":
        return request { id in
            guard let keys = jsonBool(object["keys"]), let mouse = jsonBool(object["mouse"]) else { return nil }
            return .startInputTap(id: id, keys: keys, mouse: mouse)
        }
    case "setPollRate":
        guard let hz = jsonNumber(object["hz"]), hz >= 0 else {
            return .invalid(id: id, message: "setPollRate: \"hz\" must be a number >= 0")
        }
        return .command(.setPollRate(hz: hz))
    case "quit":
        return .command(.quit)
    default:
        return .invalid(id: id, message: "unknown command type \"\(shownType)\"")
    }
}

// MARK: - Apps

struct AppIdentity {
    let bundleId: String?
    let name: String?
    /// `bundleId` already encoded as JSON (snapshots write it for every window, every tick).
    let bundleIdJSON: String
}

/// PID → (bundle id, localized name), cached because NSRunningApplication lookups are LaunchServices
/// round trips. Entries are dropped on launch/terminate (PIDs get reused) and pruned to the PIDs
/// that currently own windows.
final class AppDirectory {
    private var cache: [pid_t: AppIdentity] = [:]

    func identity(of pid: pid_t) -> AppIdentity {
        if let cached = cache[pid] { return cached }
        let app = NSRunningApplication(processIdentifier: pid)
        let bundleId = app?.bundleIdentifier
        var encoded = ""
        appendJSONString(bundleId, to: &encoded)
        let identity = AppIdentity(bundleId: bundleId, name: app?.localizedName, bundleIdJSON: encoded)
        cache[pid] = identity
        return identity
    }

    func invalidate(_ pid: pid_t) {
        cache[pid] = nil
    }

    /// Keeps the cache bounded: once it is much larger than the set of window owners, drop the rest.
    func prune(keepingOwnersOf windows: [WindowEntry]) {
        guard cache.count > max(appCacheMinimumEntries, windows.count * 2) else { return }
        let live = Set(windows.map(\.pid))
        cache = cache.filter { live.contains($0.key) }
    }
}

let apps = AppDirectory()

/// The frontmost app, kept current from activation notifications so that poll ticks never pay the
/// LaunchServices round trips that NSWorkspace.frontmostApplication and NSRunningApplication's
/// property getters make (profiled: several XPC calls per tick otherwise). Re-synced from
/// NSWorkspace on Space changes, when the frontmost app terminates, after every activation (with
/// the fullscreen follow-up) and at least every `settings.resyncInterval` as a safety net.
final class FrontmostTracker {
    private(set) var pid: pid_t?
    private(set) var bundleId: String?
    private(set) var name: String?
    private var syncedAt = -Double.infinity

    func resync() {
        update(from: NSWorkspace.shared.frontmostApplication)
    }

    func resyncIfStale() {
        if monotonicNow() - syncedAt >= settings.resyncInterval { resync() }
    }

    func update(from app: NSRunningApplication?) {
        let processId = app?.processIdentifier ?? -1
        pid = processId > 0 ? processId : nil
        bundleId = app?.bundleIdentifier
        name = app?.localizedName
        syncedAt = monotonicNow()
    }
}

let frontmost = FrontmostTracker()

// MARK: - Windows and displays

struct WindowEntry {
    let wid: Int64
    let pid: pid_t
    let layer: Int64
    let frame: CGRect
    let onScreen: Bool
    let alpha: Double
}

/// On-screen windows in front-to-back order (the order CGWindowList returns; never re-sorted).
/// Returns nil when the window server cannot be queried.
func readWindowList() -> [WindowEntry]? {
    guard let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) else {
        return nil
    }
    let list = raw as NSArray
    var windows: [WindowEntry] = []
    windows.reserveCapacity(list.count)
    for case let info as NSDictionary in list {
        guard let wid = info[kCGWindowNumber] as? NSNumber,
              let pid = info[kCGWindowOwnerPID] as? NSNumber,
              let boundsInfo = info[kCGWindowBounds] as? NSDictionary,
              let frame = CGRect(dictionaryRepresentation: boundsInfo as CFDictionary)
        else { continue }
        let layer = (info[kCGWindowLayer] as? NSNumber)?.int64Value ?? 0
        // Every entry of an on-screen-only list is on screen; the flag is optional in the API.
        let onScreen = (info[kCGWindowIsOnscreen] as? NSNumber)?.boolValue ?? true
        let alpha = (info[kCGWindowAlpha] as? NSNumber)?.doubleValue ?? 1
        windows.append(WindowEntry(wid: wid.int64Value, pid: pid.int32Value, layer: layer, frame: frame, onScreen: onScreen, alpha: alpha))
    }
    return windows
}

func snapshotLine(id: Int64?, windows: [WindowEntry]) -> String {
    var out = String()
    out.reserveCapacity(64 + windows.count * 128)
    out.append("{\"type\":\"snapshot\",\"id\":")
    out.append(id.map { String($0) } ?? "null")
    out.append(",\"ts\":")
    appendJSONNumber(unixNow(), to: &out)
    out.append(",\"windows\":[")
    for (index, window) in windows.enumerated() {
        if index > 0 { out.append(",") }
        out.append("{\"wid\":")
        out.append(String(window.wid))
        out.append(",\"pid\":")
        out.append(String(window.pid))
        out.append(",\"bundleId\":")
        out.append(apps.identity(of: window.pid).bundleIdJSON)
        out.append(",\"layer\":")
        out.append(String(window.layer))
        out.append(",\"x\":")
        appendJSONNumber(Double(window.frame.origin.x), to: &out)
        out.append(",\"y\":")
        appendJSONNumber(Double(window.frame.origin.y), to: &out)
        out.append(",\"w\":")
        appendJSONNumber(Double(window.frame.size.width), to: &out)
        out.append(",\"h\":")
        appendJSONNumber(Double(window.frame.size.height), to: &out)
        out.append(",\"onScreen\":")
        out.append(window.onScreen ? "true" : "false")
        out.append(",\"alpha\":")
        appendJSONNumber(window.alpha, to: &out)
        out.append("}")
    }
    out.append("]}")
    return out
}

struct DisplayEntry: Equatable {
    let id: CGDirectDisplayID
    /// Global points, top-left origin of the main display, y down.
    let bounds: CGRect
    /// Height (pt) of the band at the top of the display that a camera housing ("notch") obscures:
    /// NSScreen.safeAreaInsets.top. 0 on displays without one.
    let topInset: CGFloat
}

/// Active displays in global points (top-left origin of the main display, y down). Main thread
/// only (NSScreen).
func activeDisplays() -> [DisplayEntry] {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
    let insets = cameraHousingInsets()
    return ids.prefix(Int(count)).map { id in
        let bounds = CGDisplayBounds(id)
        // NSScreen caches its screens, and without a running NSApplication nothing guarantees that
        // cache follows a resolution change, so an inset is only trusted while the size it was
        // measured for still matches the display. Otherwise: 0, i.e. only the full-bounds test.
        let inset = insets[id].flatMap { $0.size == bounds.size ? $0.top : nil } ?? 0
        return DisplayEntry(id: id, bounds: bounds, topInset: inset)
    }
}

/// NSScreen's safe-area top inset (with the frame size it belongs to) per display that has one.
///
/// Side effect (measured): the first NSScreen access checks this process in with LaunchServices as
/// a "BackgroundOnly" app (lsappinfo lists it; no Dock icon, menu or window) and adds ~1 MB of
/// footprint. No App Nap throttling was seen (180 s at 4 Hz: exactly 120 pushes per 30 s, max gap
/// 270 ms). If it ever appears, opt out with ProcessInfo.beginActivity(.userInitiatedAllowingIdleSystemSleep).
func cameraHousingInsets() -> [CGDirectDisplayID: (top: CGFloat, size: CGSize)] {
    var result: [CGDirectDisplayID: (top: CGFloat, size: CGSize)] = [:]
    let key = NSDeviceDescriptionKey("NSScreenNumber")
    for screen in NSScreen.screens {
        guard let number = screen.deviceDescription[key] as? NSNumber else { continue }
        let top = screen.safeAreaInsets.top
        if top > 0 { result[number.uint32Value] = (top, screen.frame.size) }
    }
    return result
}

/// Display bounds for the per-tick fullscreen check (each query is a window-server round trip).
/// Invalidated by display reconfiguration, with `settings.resyncInterval` as a safety net.
final class DisplayCache {
    private var cached: [DisplayEntry] = []
    private var fetchedAt = -Double.infinity

    var displays: [DisplayEntry] {
        if monotonicNow() - fetchedAt >= settings.resyncInterval { return refresh() }
        return cached
    }

    /// Re-reads the displays now (requests always answer from fresh data).
    @discardableResult
    func refresh() -> [DisplayEntry] {
        cached = activeDisplays()
        fetchedAt = monotonicNow()
        return cached
    }

    func invalidate() {
        fetchedAt = -Double.infinity
    }

    func observeReconfiguration() {
        CGDisplayRegisterReconfigurationCallback({ _, _, _ in
            DispatchQueue.main.async { displayCache.invalidate() }
        }, nil)
    }
}

let displayCache = DisplayCache()

// MARK: - Fullscreen (§5.3 heuristic)

func rectsMatch(_ a: CGRect, _ b: CGRect, tolerance: CGFloat) -> Bool {
    abs(a.minX - b.minX) <= tolerance && abs(a.minY - b.minY) <= tolerance
        && abs(a.width - b.width) <= tolerance && abs(a.height - b.height) <= tolerance
}

/// The displays (in display-list order) on which `pid` owns a layer-0 on-screen window covering
/// the whole display: its full bounds (not its visible frame), or, on a display with a camera
/// housing, the full area below the housing; each within ±tolerance.
// SPEC-DEVIATION: §5.3 also says "or the active Space is a fullscreen Space"; no public API tells
// a fullscreen Space apart, so this window test stands in for it, and Space changes only trigger an
// immediate re-check plus a follow-up. On a display with a camera housing (this M4 Air: safe-area
// top inset 33 pt of 1107), macOS places a native-fullscreen window below the housing, so it would
// not equal the full bounds; hence the second accepted rectangle. NOT VERIFIED ON DEVICE: entering
// native fullscreen switches the user's Space, so no real native-fullscreen window has been
// measured with either rectangle (lead check: `build/tools/probe levels --all` while an app is
// fullscreen, against `probe screens`). A zoomed window (visible frame: below the 38 pt menu bar)
// stays distinguishable from the 33 pt housing band at a 1 pt tolerance.
func fullscreenDisplayIds(pid: pid_t, windows: [WindowEntry], displays: [DisplayEntry], tolerance: CGFloat) -> [CGDirectDisplayID] {
    var matched: [CGDirectDisplayID] = []
    for display in displays {
        let full = display.bounds
        let belowHousing = CGRect(x: full.minX, y: full.minY + display.topInset, width: full.width, height: full.height - display.topInset)
        let covered = windows.contains { window in
            window.pid == pid && window.layer == 0 && window.onScreen
                && (rectsMatch(window.frame, full, tolerance: tolerance)
                    || (display.topInset > 0 && rectsMatch(window.frame, belowHousing, tolerance: tolerance)))
        }
        if covered { matched.append(display.id) }
    }
    return matched
}

struct FullscreenState: Equatable {
    let value: Bool
    let bundleId: String?
    /// The displays the frontmost app covers (empty when `value` is false). Main hides the pet only
    /// when its own display is among them (§8.6, §8.7).
    let displayIds: [CGDirectDisplayID]
}

/// Whether going from `previous` to `current` is reported: always the first time (initial state),
/// then when the value changes or, while fullscreen, when the fullscreen app or its displays change.
func shouldReport(previous: FullscreenState?, current: FullscreenState) -> Bool {
    guard let previous else { return true }
    if previous.value != current.value { return true }
    return current.value && (previous.bundleId != current.bundleId || previous.displayIds != current.displayIds)
}

/// {"type":"frontmostFullscreen",...}: unsolicited (no id) or the reply to fullscreenState.
func fullscreenLine(id: Int64?, state: FullscreenState) -> String {
    var json = JSONObject()
    json.string("type", "frontmostFullscreen")
    if let id { json.int("id", id) }
    json.bool("value", state.value)
    json.string("bundleId", state.bundleId)
    json.raw("displayIds", "[" + state.displayIds.map { String($0) }.joined(separator: ",") + "]")
    return json.finish()
}

final class FullscreenMonitor {
    private var last: FullscreenState?
    private var followUpGeneration = 0
    private var idleTimer: DispatchSourceTimer?

    /// Evaluates the heuristic for the tracked frontmost app. `windows` lets a poll tick reuse its
    /// window list. `fresh` (requests) re-reads the frontmost app and displays instead of using caches.
    func evaluate(windows: [WindowEntry]? = nil, fresh: Bool = false) -> FullscreenState? {
        if fresh { frontmost.resync() } else { frontmost.resyncIfStale() }
        guard let pid = frontmost.pid else { return FullscreenState(value: false, bundleId: nil, displayIds: []) }
        guard let list = windows ?? readWindowList() else { return nil }
        let displays = fresh ? displayCache.refresh() : displayCache.displays
        let ids = fullscreenDisplayIds(pid: pid, windows: list, displays: displays, tolerance: settings.fullscreenTolerance)
        return FullscreenState(value: !ids.isEmpty, bundleId: frontmost.bundleId, displayIds: ids)
    }

    /// Emits an unsolicited frontmostFullscreen line when `shouldReport` says so.
    func record(_ state: FullscreenState) {
        guard shouldReport(previous: last, current: state) else { return }
        last = state
        output.send(fullscreenLine(id: nil, state: state))
    }

    func check(windows: [WindowEntry]? = nil, fresh: Bool = false) {
        if let state = evaluate(windows: windows, fresh: fresh) { record(state) }
    }

    /// Immediate check plus one debounced, fully re-synced follow-up once the transition settles.
    func checkSoon() {
        check()
        followUpGeneration &+= 1
        let generation = followUpGeneration
        guard settings.fullscreenFollowUpDelay > 0 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + settings.fullscreenFollowUpDelay) { [weak self] in
            guard let self, generation == self.followUpGeneration else { return }
            autoreleasepool { self.check(fresh: true) }
        }
    }

    /// Runs the background cadence only while snapshot polling is slower than it.
    func updateIdleTimer(pollHz: Double) {
        let idleHz = settings.fullscreenIdleHz
        let wanted = idleHz > 0 && pollHz < idleHz
        if wanted == (idleTimer != nil) { return }
        idleTimer?.cancel()
        idleTimer = nil
        guard wanted else { return }
        let interval = 1.0 / idleHz
        let timer = DispatchSource.makeTimerSource(queue: .main)
        // Generous leeway: this check is latency-tolerant, so let the OS coalesce wakeups.
        timer.schedule(deadline: .now() + interval, repeating: interval, leeway: .milliseconds(Int(interval * 200)))
        timer.setEventHandler { [weak self] in autoreleasepool { self?.check() } }
        timer.resume()
        idleTimer = timer
    }
}

let fullscreen = FullscreenMonitor()

// MARK: - Snapshot polling

final class Poller {
    private(set) var hz = 0.0
    private var timer: DispatchSourceTimer?

    func setRate(_ requested: Double) {
        let clamped = requested <= 0 ? 0 : min(max(requested, minPollHz), maxPollHz)
        guard clamped != hz else { return }
        hz = clamped
        timer?.cancel()
        timer = nil
        if hz > 0 {
            let interval = 1.0 / hz
            let timer = DispatchSource.makeTimerSource(queue: .main)
            // First push immediately (a rate change usually means "I need fresh data now"); 5% leeway
            // lets the OS coalesce wakeups without visibly jittering window riding at 15 Hz.
            timer.schedule(deadline: .now(), repeating: interval, leeway: .microseconds(Int(interval * 50_000)))
            timer.setEventHandler { autoreleasepool { pollTick() } }
            timer.resume()
            self.timer = timer
        }
        fullscreen.updateIdleTimer(pollHz: hz)
    }
}

let poller = Poller()

/// One window-server query per tick, shared by the snapshot push and the fullscreen check.
// SPEC-DEVIATION: §11 budgets the helper at < 0.5% CPU. Measured on this M4 (~15 windows, rusage
// over 15-20 s): ~0.05% idle, ~0.2% at 4 Hz (normal), but ~0.6-0.8% at 15 Hz (only while the pet
// rides a window). Every public window-server query costs ~0.3-0.4 ms of CPU from a timer wakeup,
// whether it lists all windows (~0.42 ms with field reads) or one window (~0.3 ms; 0.43-0.46% at
// 15 Hz on its own), so no public-API polling at >= 10 Hz stays under 0.5% here (10 Hz: 0.56%),
// and "4 Hz full + 15 Hz public single-window" would still cost ~0.6%. The private SkyLight call
// SLSGetWindowBounds measured 0.06-0.09 ms per tick (0.09-0.135% at 15 Hz, about the timer's own
// cost), so "4 Hz full + 15 Hz private bounds of the ridden window" (~0.3%) would meet the budget.
// That is a protocol change plus private SPI: a decision for the lead, not implemented.
func pollTick() {
    guard let windows = readWindowList() else { return }
    output.send(snapshotLine(id: nil, windows: windows))
    fullscreen.check(windows: windows)
    apps.prune(keepingOwnersOf: windows)
}

// MARK: - Input tap
// SPEC-DEVIATION: replaces uiohook-napi (§3, §7.1, §10.4); see the note at the top of this file.

/// CGEventTimestamp is documented as nanoseconds since boot, but Apple-silicon Macs have been
/// observed to deliver mach_absolute_time ticks instead. Both count the same uptime clock, so the
/// unit giving the smallest non-negative age is the right one (on Intel they coincide).
let machTimebase: mach_timebase_info_data_t = {
    var info = mach_timebase_info_data_t()
    mach_timebase_info(&info)
    return info
}()

func unixTime(ofEventTimestamp timestamp: UInt64) -> Double {
    let now = unixNow()
    guard timestamp > 0 else { return now }
    var age: Double?
    let nowTicks = mach_absolute_time()
    if timestamp <= nowTicks {
        age = Double(nowTicks - timestamp) * Double(machTimebase.numer) / Double(machTimebase.denom) / 1e9
    }
    let nowNanos = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
    if timestamp <= nowNanos {
        let ageIfNanos = Double(nowNanos - timestamp) / 1e9
        if age == nil || ageIfNanos < age! { age = ageIfNanos }
    }
    guard let age, age <= maxPlausibleEventAge else { return now }
    return now - age
}

/// Shared with the tap's C callback through its refcon. `port` is set before the tap thread starts
/// and `runLoop` before it signals readiness; neither changes afterwards.
final class TapContext {
    var port: CFMachPort?
    var runLoop: CFRunLoop?
}

/// Builds one input line. Only the fields of the protocol are read from the event; key codes are
/// never mapped to characters (no keyboard-layout APIs are used anywhere in this program).
func inputLine(type: CGEventType, event: CGEvent) -> String? {
    let ts = unixTime(ofEventTimestamp: event.timestamp)
    var json = JSONObject(capacity: 128)
    json.string("type", "input")
    switch type {
    case .keyDown, .keyUp:
        json.string("kind", "key")
        json.bool("down", type == .keyDown)
        json.int("code", event.getIntegerValueField(.keyboardEventKeycode))
        json.bool("repeat", event.getIntegerValueField(.keyboardEventAutorepeat) != 0)
    case .leftMouseDown, .rightMouseDown, .otherMouseDown:
        let flags = event.flags
        let alt = flags.contains(.maskAlternate)
        let cmd = flags.contains(.maskCommand)
        json.string("kind", "mouseDown")
        json.int("button", event.getIntegerValueField(.mouseEventButtonNumber))
        json.bool("alt", alt)
        json.bool("cmd", cmd)
        json.bool("shift", flags.contains(.maskShift))
        json.bool("ctrl", flags.contains(.maskControl))
        // Data minimisation (§2): only ⌥⌘-click send-to-point (§10.4) needs a location. Every other
        // click is reported without one, so main can never tell which app or window it landed in.
        if alt && cmd {
            let location = event.location // global points, top-left origin (same space as window bounds)
            json.number("x", Double(location.x))
            json.number("y", Double(location.y))
        } else {
            json.raw("x", "null")
            json.raw("y", "null")
        }
    case .scrollWheel:
        // Axis 1 is vertical, axis 2 horizontal. Trackpad gesture begin/end events carry zero
        // deltas on both axes; main ignores those.
        json.string("kind", "scroll")
        json.int("lines", event.getIntegerValueField(.scrollWheelEventDeltaAxis1))
        json.number("px", event.getDoubleValueField(.scrollWheelEventPointDeltaAxis1))
        json.int("linesX", event.getIntegerValueField(.scrollWheelEventDeltaAxis2))
        json.number("pxX", event.getDoubleValueField(.scrollWheelEventPointDeltaAxis2))
        json.bool("continuous", event.getIntegerValueField(.scrollWheelEventIsContinuous) != 0)
        json.bool("momentum", event.getIntegerValueField(.scrollWheelEventMomentumPhase) != 0)
    default:
        return nil
    }
    json.number("ts", ts)
    return json.finish()
}

func inputTapCallback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    autoreleasepool {
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            // The system switches taps off when it thinks they are slow or when secure input
            // toggles; switch ours straight back on. Listen-only, so this never blocks input.
            if let refcon, let port = Unmanaged<TapContext>.fromOpaque(refcon).takeUnretainedValue().port {
                CGEvent.tapEnable(tap: port, enable: true)
            }
            logDiagnostic(type == .tapDisabledByTimeout ? "input tap re-enabled after timeout" : "input tap re-enabled after user-input disable")
        default:
            if let line = inputLine(type: type, event: event) { output.send(line) }
        }
    }
    // Listen-only taps cannot modify or swallow events; the return value is ignored.
    return Unmanaged.passUnretained(event)
}

/// keys → keyDown, keyUp; mouse → left/right/other mouseDown and scrollWheel. Nothing else (no
/// mouse moves, drags, ups or modifier-only changes) ever reaches this process. Modifier-only
/// presses are deliberately not observed: they type nothing (§7.2 crumbs count key presses), and
/// mouseDown events carry the modifier state that ⌥⌘-click needs (§10.4).
func inputTapMask(keys: Bool, mouse: Bool) -> CGEventMask {
    var mask: CGEventMask = 0
    func include(_ type: CGEventType) { mask |= CGEventMask(1) << CGEventMask(type.rawValue) }
    if keys {
        include(.keyDown)
        include(.keyUp)
    }
    if mouse {
        include(.leftMouseDown)
        include(.rightMouseDown)
        include(.otherMouseDown)
        include(.scrollWheel)
    }
    return mask
}

/// The result of startInputTap, as reported in the inputTap reply.
struct TapOutcome: Equatable {
    let active: Bool
    let error: String?
    /// Machine-readable failure for main: "notGranted" (no tap was attempted, so nothing prompted)
    /// or "tapCreateFailed" (granted, but macOS refused the tap, e.g. until a relaunch, §15.1).
    let reason: String?

    static let inactive = TapOutcome(active: false, error: nil, reason: nil)
    static let started = TapOutcome(active: true, error: nil, reason: nil)
    static let notGranted = TapOutcome(active: false, error: "Input Monitoring is not granted", reason: "notGranted")
    static let tapCreateFailed = TapOutcome(
        active: false,
        error: "CGEventTapCreate failed although Input Monitoring is granted (macOS may need a relaunch)",
        reason: "tapCreateFailed"
    )
}

func inputTapLine(id: Int64, outcome: TapOutcome) -> String {
    var json = JSONObject()
    json.string("type", "inputTap")
    json.int("id", id)
    json.bool("active", outcome.active)
    json.string("error", outcome.error)
    json.string("reason", outcome.reason)
    return json.finish()
}

final class InputTap {
    private(set) var keys = false
    private(set) var mouse = false
    private var port: CFMachPort?
    private var context: TapContext?
    private var finished: DispatchSemaphore?

    var isActive: Bool { port != nil }

    /// Starts, reconfigures or (keys and mouse both false) stops the tap.
    ///
    /// Placement: a LISTEN-ONLY tap at kCGSessionEventTap, appended at the tail.
    ///  - Listen-only: Bitbot only counts input, so it must never be able to delay, alter or swallow
    ///    an event (§10.4 "never intercept or block the click"); it also only needs Input Monitoring,
    ///    not Accessibility.
    ///  - Session level (not HID): sees exactly the events delivered to the user's login session,
    ///    including those from remappers and accessibility tools, without the extra privilege a
    ///    HID-level tap needs.
    ///  - Tail-append: observes events after any other session filters have run, i.e. what apps
    ///    actually receive (a key suppressed by a remapper is not counted).
    ///
    /// `listenAccess` is the Input Monitoring preflight (injectable for tests). Main thread only.
    func start(keys: Bool, mouse: Bool, listenAccess: () -> Bool = CGPreflightListenEventAccess) -> TapOutcome {
        // Capturing nothing is a stop: switching both kinds off must never leave a tap running.
        guard keys || mouse else {
            stop()
            return .inactive
        }
        if isActive && self.keys == keys && self.mouse == mouse { return .started }
        stop() // a failed reconfiguration leaves no tap running (fail closed)

        // Preflight first (never prompts): creating a tap without the grant can make macOS show the
        // Input Monitoring prompt, and only requestInputAccess may prompt (onboarding §15.1; "never
        // a nag popup" §7.1). The client re-applies taps after every restart, so this matters.
        // Mouse-only taps are gated too: degraded mode counts no clicks or scrolls either (§7.1).
        guard listenAccess() else { return .notGranted }

        let context = TapContext()
        guard let port = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .tailAppendEventTap,
            options: .listenOnly,
            eventsOfInterest: inputTapMask(keys: keys, mouse: mouse),
            callback: inputTapCallback,
            userInfo: Unmanaged.passUnretained(context).toOpaque()
        ) else {
            return .tapCreateFailed
        }
        context.port = port

        let ready = DispatchSemaphore(value: 0)
        let finished = DispatchSemaphore(value: 0)
        let thread = Thread {
            let loop = CFRunLoopGetCurrent()
            context.runLoop = loop
            let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)
            CFRunLoopAddSource(loop, source, .commonModes)
            CGEvent.tapEnable(tap: port, enable: true)
            ready.signal()
            CFRunLoopRun() // returns once stop() invalidates the port or stops the loop
            finished.signal()
        }
        thread.name = "bitbot-helper.input-tap"
        thread.qualityOfService = .userInteractive
        thread.start()
        ready.wait()

        self.keys = keys
        self.mouse = mouse
        self.port = port
        self.context = context
        self.finished = finished
        return .started
    }

    /// Stops the tap and waits for its thread, so no input line is written after the reply.
    func stop() {
        guard let port else { return }
        CGEvent.tapEnable(tap: port, enable: false)
        CFMachPortInvalidate(port) // also invalidates the run loop source, which ends CFRunLoopRun
        if let runLoop = context?.runLoop { CFRunLoopStop(runLoop) }
        if let finished, finished.wait(timeout: .now() + tapThreadStopTimeout) == .timedOut, let context {
            // The thread may still be inside the callback; keep its context alive (a few bytes).
            _ = Unmanaged.passRetained(context)
            logDiagnostic("input tap thread did not stop within 1 s")
        }
        self.port = nil
        self.context = nil
        self.finished = nil
        keys = false
        mouse = false
    }
}

let inputTap = InputTap()

// MARK: - Permissions

/// TCC queries are IPC to tccd: 10-40 ms each (measured), so they run here instead of on main.
let permissionQueue = DispatchQueue(label: "bitbot-helper.permissions", qos: .utility, attributes: .concurrent)

/// Preflight calls only: they never show a prompt. Any thread.
func inputAccessLine(id: Int64) -> String {
    var json = JSONObject()
    json.string("type", "inputAccess")
    json.int("id", id)
    json.bool("listen", CGPreflightListenEventAccess())
    json.bool("post", CGPreflightPostEventAccess())
    json.bool("accessibility", AXIsProcessTrusted())
    return json.finish()
}

// MARK: - Diagnostics

typealias ResponsibilityFunction = @convention(c) (pid_t) -> pid_t

/// Private SPI (libquarantine): the process macOS TCC attributes this process's permission
/// checks to. Absent on some systems; then diag reports null.
let responsiblePidFunction: ResponsibilityFunction? = {
    let defaultHandle = UnsafeMutableRawPointer(bitPattern: -2) // RTLD_DEFAULT
    guard let symbol = dlsym(defaultHandle, "responsibility_get_pid_responsible_for_pid") else { return nil }
    return unsafeBitCast(symbol, to: ResponsibilityFunction.self)
}()

func executablePath(of pid: pid_t) -> String? {
    var buffer = [UInt8](repeating: 0, count: 4 * Int(MAXPATHLEN)) // PROC_PIDPATHINFO_MAXSIZE
    let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
    guard length > 0 else { return nil }
    return String(decoding: buffer.prefix(Int(length)), as: UTF8.self)
}

func diagLine(id: Int64) -> String {
    let pid = getpid()
    var responsible: pid_t?
    if let function = responsiblePidFunction {
        let value = function(pid)
        if value > 0 { responsible = value }
    }
    var json = JSONObject(capacity: 256)
    json.string("type", "diag")
    json.int("id", id)
    json.int("pid", Int64(pid))
    json.int("ppid", Int64(getppid()))
    json.int("responsiblePid", responsible.map { Int64($0) })
    json.string("responsiblePath", responsible.flatMap { executablePath(of: $0) })
    json.string("executablePath", executablePath(of: pid))
    json.int("version", Int64(protocolVersion))
    return json.finish()
}

// MARK: - Command execution

func execute(_ command: Command) {
    switch command {
    case .snapshot(let id):
        guard let windows = readWindowList() else {
            sendError(id: id, "window list unavailable")
            return
        }
        output.send(snapshotLine(id: id, windows: windows))
        fullscreen.check(windows: windows)

    case .setPollRate(let hz):
        poller.setRate(hz)

    case .ping(let id):
        var json = JSONObject(capacity: 32)
        json.string("type", "pong")
        json.int("id", id)
        output.send(json.finish())

    case .displays(let id):
        let mainId = CGMainDisplayID()
        let displays = displayCache.refresh()
        var list = "["
        for (index, display) in displays.enumerated() {
            if index > 0 { list.append(",") }
            var item = JSONObject(capacity: 96)
            item.int("id", Int64(display.id))
            item.number("x", Double(display.bounds.origin.x))
            item.number("y", Double(display.bounds.origin.y))
            item.number("w", Double(display.bounds.size.width))
            item.number("h", Double(display.bounds.size.height))
            item.bool("main", display.id == mainId)
            list.append(item.finish())
        }
        list.append("]")
        var json = JSONObject(capacity: list.utf8.count + 48)
        json.string("type", "displays")
        json.int("id", id)
        json.raw("displays", list)
        output.send(json.finish())

    case .frontmost(let id):
        let state = fullscreen.evaluate(fresh: true) // re-reads the frontmost app from NSWorkspace
        var json = JSONObject()
        json.string("type", "frontmost")
        json.int("id", id)
        json.string("bundleId", frontmost.bundleId)
        json.int("pid", frontmost.pid.map { Int64($0) })
        json.string("appName", frontmost.name)
        json.bool("fullscreen", state?.value ?? false)
        output.send(json.finish())
        if let state { fullscreen.record(state) }

    case .appInfo(let id, let pid):
        apps.invalidate(pid) // always answer from a fresh lookup
        let identity = apps.identity(of: pid)
        var json = JSONObject()
        json.string("type", "appInfo")
        json.int("id", id)
        json.int("pid", Int64(pid))
        json.string("bundleId", identity.bundleId)
        json.string("appName", identity.name)
        output.send(json.finish())

    case .inputAccess(let id):
        permissionQueue.async { autoreleasepool { output.send(inputAccessLine(id: id)) } }

    case .requestInputAccess(let id):
        permissionQueue.async {
            autoreleasepool {
                // Shows the system Input Monitoring prompt when the user has not decided yet. The
                // reply carries the preflight state right after; main polls inputAccess for the grant.
                _ = CGRequestListenEventAccess()
                output.send(inputAccessLine(id: id))
            }
        }

    case .startInputTap(let id, let keys, let mouse):
        output.send(inputTapLine(id: id, outcome: inputTap.start(keys: keys, mouse: mouse)))

    case .stopInputTap(let id):
        inputTap.stop()
        output.send(inputTapLine(id: id, outcome: .inactive))

    case .diag(let id):
        output.send(diagLine(id: id))

    case .fullscreenState(let id):
        guard let state = fullscreen.evaluate(fresh: true) else {
            sendError(id: id, "window list unavailable")
            return
        }
        output.send(fullscreenLine(id: id, state: state))
        fullscreen.record(state)

    case .quit:
        inputTap.stop()
        exit(0)
    }
}

func handleLine(_ data: Data) {
    autoreleasepool {
        switch parseCommand(data) {
        case .command(let command): execute(command)
        case .invalid(let id, let message): sendError(id: id, message)
        }
    }
}

// MARK: - stdin

/// Reads stdin on its own thread, splits it into lines (LF or CRLF) and runs each on main.
/// Over-long lines are discarded up to the next newline. EOF means the parent is gone: exit.
func startStdinReader() {
    let thread = Thread {
        var pending: [UInt8] = []
        var discarding = false
        var chunk = [UInt8](repeating: 0, count: 16 * 1024)

        func deliver(_ bytes: ArraySlice<UInt8>) {
            var line = bytes
            if line.last == 0x0D { line = line.dropLast() } // CRLF
            guard line.contains(where: { $0 != 0x20 && $0 != 0x09 }) else { return } // blank
            let data = Data(line)
            DispatchQueue.main.async { handleLine(data) }
        }

        func overflow() {
            DispatchQueue.main.async { sendError(id: nil, "command longer than \(maxCommandBytes) bytes; discarded") }
        }

        reading: while true {
            let count = chunk.withUnsafeMutableBytes { read(STDIN_FILENO, $0.baseAddress, $0.count) }
            if count < 0 {
                if errno == EINTR { continue }
                break reading
            }
            if count == 0 { break reading }
            var start = 0
            for index in 0..<count where chunk[index] == 0x0A {
                if discarding {
                    discarding = false
                } else if pending.isEmpty {
                    if index - start <= maxCommandBytes { deliver(chunk[start..<index]) } else { overflow() }
                } else {
                    pending.append(contentsOf: chunk[start..<index])
                    if pending.count <= maxCommandBytes { deliver(pending[...]) } else { overflow() }
                    pending.removeAll(keepingCapacity: true)
                }
                start = index + 1
            }
            if start < count && !discarding {
                pending.append(contentsOf: chunk[start..<count])
                if pending.count > maxCommandBytes {
                    pending.removeAll(keepingCapacity: false)
                    discarding = true
                    overflow()
                }
            }
        }
        // Let main finish what it is doing, but never outlive the parent if main is wedged.
        DispatchQueue.main.async { exit(0) }
        sleep(parentGoneExitGraceSeconds)
        _exit(0)
    }
    thread.name = "bitbot-helper.stdin"
    thread.start()
}

// MARK: - Startup pieces (called from main.swift)

func helloLine() -> String {
    var hello = JSONObject(capacity: 64)
    hello.string("type", "hello")
    hello.int("version", Int64(protocolVersion))
    hello.int("pid", Int64(getpid()))
    return hello.finish()
}

func appEventLine(type: String, app: NSRunningApplication) -> String {
    var json = JSONObject()
    json.string("type", type)
    json.string("bundleId", app.bundleIdentifier)
    json.int("pid", Int64(app.processIdentifier))
    json.string("appName", app.localizedName)
    json.number("ts", unixNow())
    return json.finish()
}

func observeWorkspace() {
    let center = NSWorkspace.shared.notificationCenter
    func app(_ note: Notification) -> NSRunningApplication? {
        note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
    }
    center.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { note in
        autoreleasepool {
            guard let launched = app(note) else { return }
            apps.invalidate(launched.processIdentifier)
            output.send(appEventLine(type: "appLaunched", app: launched))
        }
    }
    center.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
        autoreleasepool {
            guard let activated = app(note) else { return }
            output.send(appEventLine(type: "appActivated", app: activated))
            frontmost.update(from: activated) // the notification names the new frontmost app
            fullscreen.checkSoon()
        }
    }
    center.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { note in
        autoreleasepool {
            guard let terminated = app(note) else { return }
            output.send(appEventLine(type: "appTerminated", app: terminated))
            apps.invalidate(terminated.processIdentifier)
            if terminated.processIdentifier == frontmost.pid { frontmost.resync() }
        }
    }
    center.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { _ in
        autoreleasepool {
            frontmost.resync()
            fullscreen.checkSoon()
        }
    }
}

/// Exit as soon as the parent dies, even if something else still holds our stdin open.
var parentWatch: DispatchSourceProcess?

func watchParent() {
    let parent = getppid()
    guard parent > 1 else { return }
    let source = DispatchSource.makeProcessSource(identifier: parent, eventMask: .exit, queue: .main)
    source.setEventHandler { exit(0) }
    source.resume()
    parentWatch = source
    if getppid() != parent { exit(0) } // parent died before the watch was armed
}
