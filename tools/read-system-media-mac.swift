// Read-only diagnostic. No title, artwork, account or audio data is recorded.
// This private OS API is optional and is never part of plugin playback.
import Foundation
import Darwin

let args = Array(CommandLine.arguments.dropFirst())
let seconds = args.first.flatMap(Double.init) ?? 0
guard seconds >= 0 && seconds <= 120 else { print("duration must be 0...120 seconds"); exit(1) }
guard let library = dlopen("/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote", RTLD_LAZY),
      let symbol = dlsym(library, "MRMediaRemoteGetNowPlayingInfo") else {
    print("system media diagnostic unavailable"); exit(1)
}
typealias ReadCallback = @convention(block) (NSDictionary?) -> Void
typealias Reader = @convention(c) (DispatchQueue, @escaping ReadCallback) -> Void
let read = unsafeBitCast(symbol, to: Reader.self)
let deadline = DispatchTime.now() + (seconds == 0 ? 4 : seconds)
var inFlight = false

func snapshot(_ info: NSDictionary?) {
    var safe: [String: Any] = ["at": Date().timeIntervalSince1970 * 1000, "available": info != nil]
    for (name, key) in [("elapsed", "kMRMediaRemoteNowPlayingInfoElapsedTime"),
                        ("rate", "kMRMediaRemoteNowPlayingInfoPlaybackRate"),
                        ("duration", "kMRMediaRemoteNowPlayingInfoDuration")] {
        if let value = info?[key] as? NSNumber { safe[name] = value }
    }
    if let timestamp = info?["kMRMediaRemoteNowPlayingInfoTimestamp"] as? Date {
        safe["timestamp"] = timestamp.timeIntervalSince1970 * 1000
    }
    if let data = try? JSONSerialization.data(withJSONObject: safe, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
}

if seconds == 0 {
    read(.main, { info in snapshot(info); exit(0) })
} else {
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now(), repeating: .milliseconds(25))
    timer.setEventHandler {
        if inFlight { return }
        inFlight = true
        read(.main, { info in inFlight = false; snapshot(info) })
    }
    timer.resume()
    // Retain the timer until the independent deadline, including if an OS
    // callback never arrives. No diagnostic task is left running indefinitely.
    DispatchQueue.main.asyncAfter(deadline: deadline) { timer.cancel(); exit(0) }
}
DispatchQueue.main.asyncAfter(deadline: deadline) { exit(seconds == 0 ? 2 : 0) }
dispatchMain()
