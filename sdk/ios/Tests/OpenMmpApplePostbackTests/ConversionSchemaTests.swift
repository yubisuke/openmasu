import Foundation
import XCTest
import OpenMmpCore
@testable import OpenMmpApplePostback

final class ConversionSchemaTests: XCTestCase {
  func testM4A30PureConversionSchemaAndDigest() throws {
    let url = try XCTUnwrap(OpenMmpConversionResources.defaultSchemaURL)
    let data = try Data(contentsOf: url)
    let provisional = try ConversionSchema(data: data)
    let schema = try ConversionSchemaRegistry(registeredDigests: [
      provisional.schemaVersion: provisional.sha256,
    ]).load(data: data)
    XCTAssertEqual(try schema.evaluate(eventCount: 0), try ConversionUpdate(fineValue: 0, coarseValue: .low, lockPostback: false))
    XCTAssertEqual(try schema.evaluate(signals: [
      .init(eventName: "session_start"), .init(eventName: "purchase"), .init(eventName: "custom_event"),
    ]), try ConversionUpdate(fineValue: 21, coarseValue: .medium, lockPostback: false))
    XCTAssertEqual(schema.sha256, ConversionSchema.digest(data: data))
    XCTAssertEqual(schema.sha256.count, 64)
    XCTAssertThrowsError(try ConversionUpdate(fineValue: 64, coarseValue: .high, lockPostback: false))
    XCTAssertThrowsError(try ConversionSchemaRegistry(registeredDigests: [:]).load(data: data)) { error in
      XCTAssertEqual(error as? OpenMmpError, .conversionSchema("conversion_schema_version_unregistered"))
    }
    XCTAssertThrowsError(try ConversionSchemaRegistry(registeredDigests: [
      provisional.schemaVersion: String(repeating: "0", count: 64),
    ]).load(data: data)) { error in
      XCTAssertEqual(error as? OpenMmpError, .conversionSchema("conversion_schema_digest_mismatch"))
    }
  }

  func testM4A31LoggingIsOptIn() async throws {
    let url = try XCTUnwrap(OpenMmpConversionResources.defaultSchemaURL)
    let schema = try ConversionSchema(data: Data(contentsOf: url))
    let updater = RecordingUpdater()
    let disabledSink = RecordingSink()
    let disabled = ConversionValueController(schema: schema, updater: updater, sink: disabledSink)
    _ = try await disabled.record(eventName: "session_start")
    let disabledEvents = await disabledSink.events
    XCTAssertEqual(disabledEvents, [])
    let enabledSink = RecordingSink()
    let enabled = ConversionValueController(schema: schema, updater: updater, sink: enabledSink, loggingEnabled: true)
    _ = try await enabled.record(eventName: "session_start")
    let enabledEvents = await enabledSink.events
    XCTAssertEqual(enabledEvents, ["openmmp.conversion_value_updated"])
  }
}

private actor RecordingUpdater: AppleConversionUpdating {
  private(set) var values: [ConversionUpdate] = []
  func update(_ value: ConversionUpdate) { values.append(value) }
}

private actor RecordingSink: ConversionEventSink {
  private(set) var events: [String] = []
  func recordConversionUpdate(schemaVersion: String, value: ConversionUpdate) {
    events.append("openmmp.conversion_value_updated")
  }
}
