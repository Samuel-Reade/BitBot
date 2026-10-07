// bitbot-helper entry point (BITBOT_SPEC.md §5.3). Everything except process startup lives in
// Helper.swift, which the Swift unit tests (helper/Tests, helper/test-helper.sh) compile without
// this file. Built by helper/build-helper.sh (swiftc, Swift 5 language mode, Command Line Tools only).

import AppKit
import Darwin
import Foundation

signal(SIGPIPE, SIG_IGN)

let launchOptions = parseArguments(Array(CommandLine.arguments.dropFirst()))
if launchOptions.printVersion {
    print("bitbot-helper protocol \(protocolVersion)")
    exit(0)
}
for message in launchOptions.diagnostics { logDiagnostic(message) }
settings = launchOptions.settings

output.send(helloLine())
observeWorkspace()
displayCache.observeReconfiguration()
autoreleasepool { fullscreen.check(fresh: true) } // initial state, once, right after hello
fullscreen.updateIdleTimer(pollHz: 0)
watchParent()
startStdinReader()

// A port keeps the main run loop alive even when no timer or observer source is attached.
RunLoop.main.add(NSMachPort(), forMode: .default)
RunLoop.main.run()
