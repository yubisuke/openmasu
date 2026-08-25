import Foundation
import OpenMmpCore

guard CommandLine.arguments.count == 4 else {
  FileHandle.standardError.write(Data("usage: OpenMmpQueueCrashProbe <stable|interrupted> <root> <ready>\n".utf8))
  exit(64)
}

let mode = CommandLine.arguments[1]
let root = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
let ready = URL(fileURLWithPath: CommandLine.arguments[3])
let storage = try OpenMmpStorage(root: root)
let upperBound: Int
switch mode {
case "stable": upperBound = 1_000
case "interrupted": upperBound = 10_000
default: exit(64)
}

for index in 0..<upperBound {
  try storage.enqueue(QueuedEvent(
    eventId: "event:\(index)",
    eventName: "custom_event",
    processingPurposeId: "analytics",
    payloadJson: "{\"event_name\":\"custom_event\",\"event_key\":\"synthetic\",\"installation_id\":\"installation:synthetic\"}",
    occurredAt: "2026-08-20T00:00:00.000Z",
    processingSequence: Int64(index + 1),
    enqueuedAtMs: Int64(index)
  ))
  if (mode == "interrupted" && index == 99) {
    try Data("ready".utf8).write(to: ready, options: .atomic)
  }
}
if mode == "stable" { try Data("ready".utf8).write(to: ready, options: .atomic) }
while true { Thread.sleep(forTimeInterval: 60) }
