// Unit tests for bitbot-helper's logic (helper/Sources/Helper.swift). Run: bash helper/test-helper.sh
//
// Compiled together with Helper.swift but without main.swift, so nothing starts: no stdin reader,
// no notifications, no hello. Input events are synthesized CGEvents that are never posted, no tap is
// ever created (the Input Monitoring preflight is injected as "not granted"), and nothing here can
// show a permission prompt. Window titles are never read.

import AppKit
import CoreGraphics
import Foundation

@main
enum HelperTests {
    static var failures = 0
    static var checks = 0

    static func check(_ condition: Bool, _ message: @autoclosure () -> String) {
        checks += 1
        if condition {
            print("ok   \(message())")
        } else {
            failures += 1
            print("FAIL \(message())")
        }
    }

    static func object(_ text: String) -> NSDictionary? {
        (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? NSDictionary
    }

    static func number(_ dictionary: NSDictionary, _ key: String) -> Double? {
        guard let value = dictionary[key] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() else { return nil }
        return value.doubleValue
    }

    static func flag(_ dictionary: NSDictionary, _ key: String) -> Bool? {
        guard let value = dictionary[key] as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { return nil }
        return value.boolValue
    }

    static func keys(_ dictionary: NSDictionary) -> Set<String> {
        Set(dictionary.allKeys.compactMap { $0 as? String })
    }

    static func main() {
        jsonEncoding()
        commandParsing()
        argumentParsing()
        fullscreenHeuristic()
        fullscreenReporting()
        eventTimestamps()
        inputTapControl()
        inputLines()
        replies()
        environment()
        print(failures == 0 ? "ALL \(checks) CHECKS PASSED" : "\(failures) OF \(checks) CHECKS FAILED")
        exit(failures == 0 ? 0 : 1)
    }

    static func jsonEncoding() {
        print("== JSON encoding")
        for sample in ["plain", "quote\"back\\slash", "new\nline\ttab\r", "ctrl\u{01}\u{08}\u{0c}\u{1f}", "émoji ☕ 🐱", "", "sep\u{2028}\u{7f}"] {
            var encoded = ""
            appendJSONString(sample, to: &encoded)
            let back = (try? JSONSerialization.jsonObject(with: Data("[\(encoded)]".utf8))) as? [String]
            check(back?.first == sample, "string round-trip \(sample.debugDescription) -> \(encoded)")
        }
        var nilString = ""
        appendJSONString(nil, to: &nilString)
        check(nilString == "null", "nil string -> null")

        for value in [0.0, -0.0, 1, -1, 1710, 0.5, 1e-7, 1e20, 123.456, -987.25, 1791336964.695967, 9.5e15, Double.pi, -2147483603] {
            var encoded = ""
            appendJSONNumber(value, to: &encoded)
            let back = ((try? JSONSerialization.jsonObject(with: Data("[\(encoded)]".utf8))) as? [NSNumber])?.first?.doubleValue
            check(back == value, "number round-trip \(value) -> \(encoded)")
        }
        for value in [Double.nan, .infinity, -.infinity] {
            var encoded = ""
            appendJSONNumber(value, to: &encoded)
            check(encoded == "null", "non-finite \(value) -> null")
        }
        var json = JSONObject()
        json.string("type", "x")
        json.int("id", nil)
        json.number("n", 2.5)
        json.bool("b", true)
        json.raw("r", "[1]")
        let built = json.finish()
        check(built == "{\"type\":\"x\",\"id\":null,\"n\":2.5,\"b\":true,\"r\":[1]}" && object(built) != nil, "JSONObject builds \(built)")
    }

    static func commandParsing() {
        print("== command parsing")
        func parsed(_ text: String) -> ParsedLine { parseCommand(Data(text.utf8)) }
        let cases: [(String, ParsedLine)] = [
            ("{\"type\":\"ping\",\"id\":3}", .command(.ping(id: 3))),
            ("{\"type\":\"snapshot\",\"id\":-4}", .command(.snapshot(id: -4))),
            ("{\"type\":\"appInfo\",\"id\":1,\"pid\":42}", .command(.appInfo(id: 1, pid: 42))),
            ("{\"type\":\"appInfo\",\"id\":1,\"pid\":0}", .invalid(id: 1, message: "appInfo: invalid arguments")),
            ("{\"type\":\"appInfo\",\"id\":1,\"pid\":3000000000}", .invalid(id: 1, message: "appInfo: invalid arguments")),
            ("{\"type\":\"startInputTap\",\"id\":2,\"keys\":true,\"mouse\":false}", .command(.startInputTap(id: 2, keys: true, mouse: false))),
            ("{\"type\":\"startInputTap\",\"id\":2,\"keys\":false,\"mouse\":false}", .command(.startInputTap(id: 2, keys: false, mouse: false))),
            ("{\"type\":\"startInputTap\",\"id\":2,\"keys\":1,\"mouse\":0}", .invalid(id: 2, message: "startInputTap: invalid arguments")),
            ("{\"type\":\"stopInputTap\",\"id\":5}", .command(.stopInputTap(id: 5))),
            ("{\"type\":\"setPollRate\",\"hz\":4}", .command(.setPollRate(hz: 4))),
            ("{\"type\":\"setPollRate\",\"hz\":true}", .invalid(id: nil, message: "setPollRate: \"hz\" must be a number >= 0")),
            ("{\"type\":\"setPollRate\",\"hz\":-0.5}", .invalid(id: nil, message: "setPollRate: \"hz\" must be a number >= 0")),
            ("{\"type\":\"quit\"}", .command(.quit)),
            ("{\"type\":\"ping\",\"id\":true}", .invalid(id: nil, message: "ping: missing or non-integer \"id\"")),
            ("{\"type\":\"ping\",\"id\":\"3\"}", .invalid(id: nil, message: "ping: missing or non-integer \"id\"")),
            ("{\"type\":\"ping\",\"id\":1.5}", .invalid(id: nil, message: "ping: missing or non-integer \"id\"")),
            ("{\"type\":\"ping\",\"id\":1e300}", .invalid(id: nil, message: "ping: missing or non-integer \"id\"")),
            ("{\"type\":\"fly\",\"id\":5}", .invalid(id: 5, message: "unknown command type \"fly\"")),
            ("[]", .invalid(id: nil, message: "malformed command: not a JSON object")),
            ("{\"id\":9}", .invalid(id: 9, message: "malformed command: missing \"type\"")),
            ("\u{ff}\u{fe}", .invalid(id: nil, message: "malformed command: not a JSON object")),
        ]
        for (input, expected) in cases {
            let got = parsed(input)
            check(got == expected, "parse \(input) -> \(got)")
        }
        let longType = String(repeating: "a", count: 500)
        if case .invalid(_, let message) = parsed("{\"type\":\"\(longType)\",\"id\":1}") {
            check(message.count < 120, "a long unknown type is truncated in the error (\(message.count) chars)")
        } else {
            check(false, "a long unknown type is rejected")
        }
    }

    static func argumentParsing() {
        print("== arguments")
        let none = parseArguments([])
        check(none.settings == HelperSettings() && !none.printVersion && none.diagnostics.isEmpty, "no arguments -> defaults")
        let all = parseArguments([
            "--fullscreen-idle-hz=2.5", "--fullscreen-tolerance-pt=3", "--fullscreen-follow-up-ms=750", "--resync-ms=2000",
        ])
        check(all.diagnostics.isEmpty, "valid flags produce no diagnostics \(all.diagnostics)")
        check(all.settings.fullscreenIdleHz == 2.5, "--fullscreen-idle-hz")
        check(all.settings.fullscreenTolerance == 3, "--fullscreen-tolerance-pt")
        check(all.settings.fullscreenFollowUpDelay == 0.75, "--fullscreen-follow-up-ms is converted to seconds")
        check(all.settings.resyncInterval == 2, "--resync-ms is converted to seconds")
        let off = parseArguments(["--fullscreen-idle-hz=0", "--fullscreen-follow-up-ms=0"])
        check(off.settings.fullscreenIdleHz == 0 && off.settings.fullscreenFollowUpDelay == 0 && off.diagnostics.isEmpty, "0 turns the idle check and the follow-up off")
        let bad = parseArguments(["--fullscreen-idle-hz=abc", "--fullscreen-tolerance-pt=-1", "--resync-ms=10", "--fullscreen-idle-hz=1e400", "--bogus=1", "stray"])
        check(bad.settings == HelperSettings(), "invalid values keep the defaults")
        check(bad.diagnostics.count == 6, "each invalid argument is reported once (\(bad.diagnostics.count))")
        check(parseArguments(["--version"]).printVersion, "--version")
    }

    static func fullscreenHeuristic() {
        print("== fullscreen heuristic")
        let plain = DisplayEntry(id: 1, bounds: CGRect(x: 0, y: 0, width: 1710, height: 1107), topInset: 0)
        let notched = DisplayEntry(id: 1, bounds: CGRect(x: 0, y: 0, width: 1710, height: 1107), topInset: 33)
        let second = DisplayEntry(id: 2, bounds: CGRect(x: 1710, y: -200, width: 2560, height: 1440), topInset: 0)
        func window(_ pid: pid_t, _ layer: Int64, _ frame: CGRect, onScreen: Bool = true) -> WindowEntry {
            WindowEntry(wid: 1, pid: pid, layer: layer, frame: frame, onScreen: onScreen, alpha: 1)
        }
        func ids(_ windows: [WindowEntry], _ displays: [DisplayEntry], tolerance: CGFloat = 1) -> [CGDirectDisplayID] {
            fullscreenDisplayIds(pid: 5, windows: windows, displays: displays, tolerance: tolerance)
        }
        let full = plain.bounds
        check(ids([window(5, 0, full)], [plain]) == [1], "a window equal to the display bounds")
        check(ids([window(5, 0, CGRect(x: 0.5, y: -1, width: 1711, height: 1106))], [plain]) == [1], "within ±1 pt")
        check(ids([window(5, 0, CGRect(x: 0, y: 0, width: 1712, height: 1107))], [plain]).isEmpty, "2 pt too wide is not fullscreen")
        check(ids([window(5, 0, CGRect(x: 0, y: 0, width: 1712, height: 1107))], [plain], tolerance: 2) == [1], "the tolerance is a parameter")
        check(ids([window(5, 0, CGRect(x: 0, y: 0.5, width: 1710, height: 1107))], [plain], tolerance: 0).isEmpty, "tolerance 0 is exact")
        check(ids([window(5, 0, CGRect(x: 0, y: 39, width: 1710, height: 983))], [plain]).isEmpty, "a zoomed (visible-frame) window is not fullscreen")
        check(ids([window(6, 0, full)], [plain]).isEmpty, "another app's full-display window does not count")
        check(ids([window(5, 3, full)], [plain]).isEmpty, "a floating-level window does not count")
        check(ids([window(5, 0, full, onScreen: false)], [plain]).isEmpty, "an off-screen window does not count")
        check(ids([window(5, 0, full)], []).isEmpty, "no displays -> none")

        let belowHousing = CGRect(x: 0, y: 33, width: 1710, height: 1074)
        check(ids([window(5, 0, belowHousing)], [notched]) == [1], "notched display: a window filling the area below the camera housing")
        check(ids([window(5, 0, CGRect(x: 0, y: 33.5, width: 1710, height: 1073))], [notched]) == [1], "notched display: below the housing within ±1 pt")
        check(ids([window(5, 0, full)], [notched]) == [1], "notched display: a window covering the full bounds (non-native fullscreen)")
        check(ids([window(5, 0, CGRect(x: 0, y: 39, width: 1710, height: 983))], [notched]).isEmpty, "notched display: a zoomed window is not fullscreen")
        check(ids([window(5, 0, CGRect(x: 0, y: 39, width: 1710, height: 1068))], [notched]).isEmpty, "notched display: zoomed with the Dock hidden is not fullscreen")
        check(ids([window(5, 0, belowHousing)], [plain]).isEmpty, "without a housing the below-housing rectangle does not count")

        check(ids([window(5, 0, second.bounds)], [plain, second]) == [2], "fullscreen on a secondary display reports that display")
        check(ids([window(5, 0, full), window(5, 0, second.bounds)], [plain, second]) == [1, 2], "fullscreen on both displays reports both, in display order")
        check(ids([window(5, 0, second.bounds), window(5, 0, second.bounds)], [plain, second]) == [2], "each display is reported once")
    }

    static func fullscreenReporting() {
        print("== fullscreen reporting")
        let off = FullscreenState(value: false, bundleId: "com.a", displayIds: [])
        let onA = FullscreenState(value: true, bundleId: "com.a", displayIds: [1])
        check(shouldReport(previous: nil, current: off), "the initial state is reported")
        check(!shouldReport(previous: off, current: off), "no change, no report")
        check(!shouldReport(previous: off, current: FullscreenState(value: false, bundleId: "com.b", displayIds: [])), "another non-fullscreen app is not a change")
        check(shouldReport(previous: off, current: onA), "entering fullscreen")
        check(shouldReport(previous: onA, current: off), "leaving fullscreen")
        check(!shouldReport(previous: onA, current: onA), "staying fullscreen")
        check(shouldReport(previous: onA, current: FullscreenState(value: true, bundleId: "com.b", displayIds: [1])), "another fullscreen app")
        check(shouldReport(previous: onA, current: FullscreenState(value: true, bundleId: "com.a", displayIds: [2])), "the fullscreen app moved to another display")

        let pushed = fullscreenLine(id: nil, state: onA)
        let pushedJSON = object(pushed)
        check(pushedJSON.map(keys) == ["type", "value", "bundleId", "displayIds"], "unsolicited line has no id: \(pushed)")
        check((pushedJSON?["displayIds"] as? [NSNumber])?.map(\.intValue) == [1], "displayIds is an array of display ids")
        let reply = object(fullscreenLine(id: 9, state: FullscreenState(value: false, bundleId: nil, displayIds: [])))
        check(reply.map { number($0, "id") == 9 && flag($0, "value") == false && ($0["bundleId"] is NSNull) && ($0["displayIds"] as? [Any])?.isEmpty == true } == true, "reply carries the id, null bundleId, empty displayIds")
    }

    static func eventTimestamps() {
        print("== event timestamps")
        let timebase = machTimebase
        func ticks(ns: UInt64) -> UInt64 { ns * UInt64(timebase.denom) / UInt64(timebase.numer) }
        let expected1 = unixNow() - 0.010
        let t1 = unixTime(ofEventTimestamp: mach_absolute_time() - ticks(ns: 10_000_000))
        check(abs(t1 - expected1) < 0.002, "mach-tick timestamp 10 ms old (error \(String(format: "%.4f", t1 - expected1)) s)")
        let expected2 = unixNow() - 0.020
        let t2 = unixTime(ofEventTimestamp: clock_gettime_nsec_np(CLOCK_UPTIME_RAW) - 20_000_000)
        check(abs(t2 - expected2) < 0.002, "nanosecond timestamp 20 ms old (error \(String(format: "%.4f", t2 - expected2)) s)")
        check(abs(unixTime(ofEventTimestamp: 0) - unixNow()) < 0.002, "zero timestamp -> now")
        check(abs(unixTime(ofEventTimestamp: UInt64.max) - unixNow()) < 0.002, "future timestamp -> now")
        check(abs(unixTime(ofEventTimestamp: mach_absolute_time() - ticks(ns: 60_000_000_000)) - unixNow()) < 0.002, "60 s old (implausible) -> now")
    }

    static func inputTapControl() {
        print("== input tap control (no tap is ever created here)")
        let keyMask: CGEventMask = (1 << 10) | (1 << 11)
        let mouseMask: CGEventMask = (1 << 1) | (1 << 3) | (1 << 25) | (1 << 22)
        check(inputTapMask(keys: true, mouse: false) == keyMask, "keys -> keyDown|keyUp")
        check(inputTapMask(keys: false, mouse: true) == mouseMask, "mouse -> left/right/other mouseDown + scrollWheel")
        check(inputTapMask(keys: true, mouse: true) == keyMask | mouseMask, "both")
        check(inputTapMask(keys: false, mouse: false) == 0, "neither -> empty mask")

        var asked = 0
        let denied: () -> Bool = {
            asked += 1
            return false
        }
        let tap = InputTap()
        check(tap.start(keys: false, mouse: false, listenAccess: denied) == .inactive && !tap.isActive, "keys and mouse both false is a stop: inactive, no error")
        check(asked == 0, "a stop never queries the permission")
        check(tap.start(keys: true, mouse: false, listenAccess: denied) == .notGranted && !tap.isActive, "keys without Input Monitoring -> notGranted, no tap")
        check(tap.start(keys: false, mouse: true, listenAccess: denied) == .notGranted && !tap.isActive, "mouse-only without Input Monitoring -> notGranted, no tap")
        check(asked == 2, "the preflight runs before any tap would be created (\(asked) queries)")
        tap.stop() // stopping an inactive tap is a no-op
        check(!tap.isActive && tap.keys == false && tap.mouse == false, "stop on an inactive tap")

        let started = object(inputTapLine(id: 3, outcome: .started))
        check(started.map { keys($0) == ["type", "id", "active", "error", "reason"] && flag($0, "active") == true && $0["error"] is NSNull && $0["reason"] is NSNull } == true, "inputTap reply (started)")
        let refused = object(inputTapLine(id: 4, outcome: .notGranted))
        check(refused.map { flag($0, "active") == false && ($0["reason"] as? String) == "notGranted" && ($0["error"] as? String)?.isEmpty == false } == true, "inputTap reply (notGranted)")
        check(object(inputTapLine(id: 5, outcome: .tapCreateFailed)).map { ($0["reason"] as? String) == "tapCreateFailed" } == true, "inputTap reply (tapCreateFailed)")
    }

    static func inputLines() {
        print("== input lines from synthesized events (never posted)")
        let timebase = machTimebase
        func ticks(ns: UInt64) -> UInt64 { ns * UInt64(timebase.denom) / UInt64(timebase.numer) }

        let key = CGEvent(keyboardEventSource: nil, virtualKey: 49, keyDown: true)!
        key.setIntegerValueField(.keyboardEventAutorepeat, value: 1)
        key.timestamp = mach_absolute_time() - ticks(ns: 15_000_000)
        let keyJSON = object(inputLine(type: .keyDown, event: key)!)!
        check(keys(keyJSON) == ["type", "kind", "down", "code", "repeat", "ts"], "key: exactly the protocol fields")
        check(keyJSON["kind"] as? String == "key" && number(keyJSON, "code") == 49 && flag(keyJSON, "down") == true && flag(keyJSON, "repeat") == true, "key: kind/code/down/repeat")
        check(abs((unixNow() - (number(keyJSON, "ts") ?? 0)) - 0.015) < 0.003, "key: ts comes from the event timestamp")
        let keyUp = object(inputLine(type: .keyUp, event: CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)!)!)!
        check(flag(keyUp, "down") == false && flag(keyUp, "repeat") == false && number(keyUp, "code") == 0, "key up, code 0, no repeat")

        let right = CGEvent(mouseEventSource: nil, mouseType: .rightMouseDown, mouseCursorPosition: CGPoint(x: 100.5, y: 200.25), mouseButton: .right)!
        right.flags = [.maskAlternate, .maskCommand]
        let rightJSON = object(inputLine(type: .rightMouseDown, event: right)!)!
        check(keys(rightJSON) == ["type", "kind", "button", "alt", "cmd", "shift", "ctrl", "x", "y", "ts"], "mouseDown: exactly the protocol fields")
        check(rightJSON["kind"] as? String == "mouseDown" && number(rightJSON, "button") == 1 && flag(rightJSON, "alt") == true && flag(rightJSON, "cmd") == true
            && flag(rightJSON, "shift") == false && flag(rightJSON, "ctrl") == false && number(rightJSON, "x") == 100.5 && number(rightJSON, "y") == 200.25,
            "mouseDown: right button, alt+cmd, location")
        let left = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: CGPoint(x: 3, y: 4), mouseButton: .left)!
        left.flags = [.maskShift, .maskControl]
        let leftJSON = object(inputLine(type: .leftMouseDown, event: left)!)!
        check(number(leftJSON, "button") == 0 && flag(leftJSON, "shift") == true && flag(leftJSON, "ctrl") == true && flag(leftJSON, "alt") == false, "mouseDown: left button, shift+ctrl")
        check(keys(leftJSON) == ["type", "kind", "button", "alt", "cmd", "shift", "ctrl", "x", "y", "ts"] && leftJSON["x"] is NSNull && leftJSON["y"] is NSNull,
            "mouseDown: no location unless both alt and cmd are held")
        let cmdOnly = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: CGPoint(x: 5, y: 6), mouseButton: .left)!
        cmdOnly.flags = [.maskCommand]
        let cmdOnlyJSON = object(inputLine(type: .leftMouseDown, event: cmdOnly)!)!
        check(cmdOnlyJSON["x"] is NSNull && cmdOnlyJSON["y"] is NSNull, "mouseDown: cmd alone does not reveal the location")
        let middle = CGEvent(mouseEventSource: nil, mouseType: .otherMouseDown, mouseCursorPosition: .zero, mouseButton: .center)!
        check(object(inputLine(type: .otherMouseDown, event: middle)!).flatMap { number($0, "button") } == 2, "mouseDown: other button number 2")

        let wheel = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: -3, wheel2: 2, wheel3: 0)!
        let wheelLine = inputLine(type: .scrollWheel, event: wheel)!
        let wheelJSON = object(wheelLine)!
        print("     \(wheelLine)")
        check(keys(wheelJSON) == ["type", "kind", "lines", "px", "linesX", "pxX", "continuous", "momentum", "ts"], "scroll: exactly the protocol fields")
        check(number(wheelJSON, "lines") == -3 && number(wheelJSON, "linesX") == 2 && flag(wheelJSON, "continuous") == false && flag(wheelJSON, "momentum") == false,
              "scroll: notched wheel, 3 lines down and 2 horizontal")
        check((number(wheelJSON, "px") ?? 0) < 0 && (number(wheelJSON, "pxX") ?? 0) > 0, "scroll: point deltas follow both axes")
        let trackpad = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: 25, wheel2: 0, wheel3: 0)!
        trackpad.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
        trackpad.setIntegerValueField(.scrollWheelEventMomentumPhase, value: 2)
        let trackpadJSON = object(inputLine(type: .scrollWheel, event: trackpad)!)!
        check(flag(trackpadJSON, "continuous") == true && flag(trackpadJSON, "momentum") == true && number(trackpadJSON, "px") == 25 && number(trackpadJSON, "pxX") == 0,
              "scroll: continuous momentum pixels, vertical only")
        check(inputLine(type: .mouseMoved, event: CGEvent(source: nil)!) == nil, "untracked event types produce nothing")
        check(inputLine(type: .flagsChanged, event: CGEvent(source: nil)!) == nil, "modifier-only changes produce nothing")
    }

    static func replies() {
        print("== replies")
        let hello = object(helloLine())
        check(hello.map { keys($0) == ["type", "version", "pid"] && number($0, "version") == Double(protocolVersion) && number($0, "pid") == Double(getpid()) } == true, "hello")
        let diag = object(diagLine(id: 7))
        check(diag.map { keys($0) == ["type", "id", "pid", "ppid", "responsiblePid", "responsiblePath", "executablePath", "version"] && number($0, "id") == 7 } == true, "diag fields")
        let access = object(inputAccessLine(id: 8)) // preflight only: never prompts
        check(access.map { keys($0) == ["type", "id", "listen", "post", "accessibility"] && flag($0, "listen") != nil && flag($0, "post") != nil && flag($0, "accessibility") != nil } == true, "inputAccess fields are booleans")
        let windows = [WindowEntry(wid: 9, pid: getpid(), layer: 0, frame: CGRect(x: 1.5, y: 2, width: 300, height: 200), onScreen: true, alpha: 0.5)]
        let snapshot = object(snapshotLine(id: nil, windows: windows))
        let first = (snapshot?["windows"] as? [NSDictionary])?.first
        check(snapshot?["id"] is NSNull && first.map { keys($0) == ["wid", "pid", "bundleId", "layer", "x", "y", "w", "h", "onScreen", "alpha"] && number($0, "x") == 1.5 && $0["bundleId"] is NSNull } == true,
              "snapshot window fields (an unbundled process has bundleId null)")
    }

    static func environment() {
        print("== environment (needs a GUI login session)")
        frontmost.resync()
        check(frontmost.pid != nil, "the frontmost tracker resolves an app (\(frontmost.bundleId ?? "no bundle id"))")
        let displays = activeDisplays()
        check(!displays.isEmpty && displays.allSatisfy { $0.topInset >= 0 && $0.topInset < $0.bounds.height / 4 }, "active displays with sane insets: \(displays.map { "\($0.id) \($0.bounds) inset \($0.topInset)" })")
        check(displayCache.refresh() == displays, "the display cache refreshes to the same displays")
        check(readWindowList() != nil, "the window list is readable")
    }
}
