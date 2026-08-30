import Foundation
import XCTest
import OpenMasuCore
@testable import OpenMasuApplePostback

final class ConversionSchemaTests: XCTestCase {
  func testM4A30PureConversionSchemaAndDigest() throws {
    let url = try XCTUnwrap(OpenMasuConversionResources.defaultSchemaURL)
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
      XCTAssertEqual(error as? OpenMasuError, .conversionSchema("conversion_schema_version_unregistered"))
    }
    XCTAssertThrowsError(try ConversionSchemaRegistry(registeredDigests: [
      provisional.schemaVersion: String(repeating: "0", count: 64),
    ]).load(data: data)) { error in
      XCTAssertEqual(error as? OpenMasuError, .conversionSchema("conversion_schema_digest_mismatch"))
    }
  }

  func testM4A31LoggingIsOptIn() async throws {
    let url = try XCTUnwrap(OpenMasuConversionResources.defaultSchemaURL)
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
    XCTAssertEqual(enabledEvents, ["openmasu.conversion_value_updated"])
  }

  func testCurrentAdAttributionKitTargetingIsOptionalAndValidated() async throws {
    let legacy = try ConversionUpdate(fineValue: 7, coarseValue: .medium, lockPostback: false)
    XCTAssertNil(legacy.conversionTypes)
    XCTAssertNil(legacy.conversionTag)

    let targeted = try ConversionUpdate(
      fineValue: 7,
      coarseValue: .medium,
      lockPostback: false,
      conversionTypes: [.reengagement],
      conversionTag: "synthetic-opaque-tag"
    )
    XCTAssertEqual(targeted.conversionTypes, [.reengagement])
    XCTAssertEqual(targeted.conversionTag, "synthetic-opaque-tag")
    XCTAssertThrowsError(try ConversionUpdate(
      fineValue: 7,
      coarseValue: .medium,
      lockPostback: false,
      conversionTypes: []
    ))
    XCTAssertThrowsError(try ConversionUpdate(
      fineValue: 7,
      coarseValue: .medium,
      lockPostback: false,
      conversionTypes: [.install, .install]
    ))
    XCTAssertThrowsError(try ConversionUpdate(
      fineValue: 7,
      coarseValue: .medium,
      lockPostback: false,
      conversionTag: ""
    ))
    XCTAssertThrowsError(try ConversionUpdate(
      fineValue: 7,
      coarseValue: .medium,
      lockPostback: false,
      conversionTypes: [.install],
      conversionTag: "synthetic-opaque-tag"
    )) { error in
      XCTAssertEqual(error as? OpenMasuError, .conversionSchema("conversion_tag_requires_reengagement"))
    }
    XCTAssertThrowsError(try ConversionUpdate(
      fineValue: 7,
      coarseValue: .medium,
      lockPostback: false,
      conversionTag: "synthetic-opaque-tag"
    )) { error in
      XCTAssertEqual(error as? OpenMasuError, .conversionSchema("conversion_tag_requires_reengagement"))
    }
  }

  func testReengagementConversionTagIsParsedAsAnOpaqueTransientValue() throws {
    let url = try XCTUnwrap(URL(string:
      "https://synthetic.example/open?AdAttributionKitReengagementOpen=opaque%2Fbookmark&dlp_slug=offer"
    ))
    XCTAssertEqual(
      AdAttributionKitReengagementURL.conversionTag(from: url),
      "opaque/bookmark"
    )
    XCTAssertNil(AdAttributionKitReengagementURL.conversionTag(from:
      try XCTUnwrap(URL(string: "https://synthetic.example/open?dlp_slug=offer"))
    ))
  }

  func testControllerForwardsTargetingWithoutLoggingTheOpaqueTag() async throws {
    let url = try XCTUnwrap(OpenMasuConversionResources.defaultSchemaURL)
    let schema = try ConversionSchema(data: Data(contentsOf: url))
    let updater = RecordingUpdater()
    let sink = RecordingSink()
    let controller = ConversionValueController(
      schema: schema,
      updater: updater,
      sink: sink,
      loggingEnabled: true
    )
    let value = try await controller.record(
      eventName: "purchase",
      conversionTypes: [.reengagement],
      conversionTag: "synthetic-opaque-tag"
    )
    XCTAssertEqual(value.conversionTypes, [.reengagement])
    XCTAssertEqual(value.conversionTag, "synthetic-opaque-tag")
    let recordedValues = await updater.values
    let loggedEvents = await sink.events
    let loggedTags = await sink.loggedTags
    XCTAssertEqual(recordedValues.last?.conversionTypes, [.reengagement])
    XCTAssertEqual(loggedEvents, ["openmasu.conversion_value_updated"])
    XCTAssertEqual(loggedTags, [])
  }

  func testInvalidTargetingDoesNotAdvanceConversionSignals() async throws {
    let url = try XCTUnwrap(OpenMasuConversionResources.defaultSchemaURL)
    let schema = try ConversionSchema(data: Data(contentsOf: url))
    let updater = RecordingUpdater()
    let controller = ConversionValueController(schema: schema, updater: updater)

    do {
      _ = try await controller.record(eventName: "invalid", conversionTag: "")
      XCTFail("empty conversion tag must fail")
    } catch {
      XCTAssertEqual(error as? OpenMasuError, .conversionSchema("conversion_tag_empty"))
    }

    let first = try await controller.record(eventName: "first")
    let second = try await controller.record(eventName: "second")
    XCTAssertEqual(first.fineValue, 0)
    XCTAssertEqual(second.fineValue, 0, "the rejected signal must not reach the three-event rule")
    let recordedValues = await updater.values
    XCTAssertEqual(recordedValues.count, 2)
  }

  func testPlatformFailureDoesNotAdvanceConversionSignals() async throws {
    let url = try XCTUnwrap(OpenMasuConversionResources.defaultSchemaURL)
    let schema = try ConversionSchema(data: Data(contentsOf: url))
    let updater = FailingOnceUpdater()
    let controller = ConversionValueController(schema: schema, updater: updater)

    do {
      _ = try await controller.record(eventName: "failed")
      XCTFail("the synthetic platform failure must be visible")
    } catch {
      XCTAssertEqual(error as? SyntheticConversionError, .updateFailed)
    }

    let first = try await controller.record(eventName: "first")
    let second = try await controller.record(eventName: "second")
    let third = try await controller.record(eventName: "third")
    XCTAssertEqual(first.fineValue, 0)
    XCTAssertEqual(second.fineValue, 0)
    XCTAssertEqual(third.fineValue, 21, "only successful platform updates may advance the signal set")
  }

  func testLoggingFailureDoesNotRollBackSuccessfulPlatformState() async throws {
    let url = try XCTUnwrap(OpenMasuConversionResources.defaultSchemaURL)
    let schema = try ConversionSchema(data: Data(contentsOf: url))
    let updater = RecordingUpdater()
    let sink = FailingOnceSink()
    let controller = ConversionValueController(
      schema: schema,
      updater: updater,
      sink: sink,
      loggingEnabled: true
    )

    do {
      _ = try await controller.record(eventName: "first")
      XCTFail("the synthetic logging failure must be visible")
    } catch {
      XCTAssertEqual(error as? SyntheticConversionError, .loggingFailed)
    }

    let second = try await controller.record(eventName: "second")
    let third = try await controller.record(eventName: "third")
    XCTAssertEqual(second.fineValue, 0)
    XCTAssertEqual(third.fineValue, 21, "a successful platform update must not be rolled back by optional logging")
    let updateCount = await updater.values.count
    XCTAssertEqual(updateCount, 3)
  }
}

private enum SyntheticConversionError: Error, Equatable {
  case updateFailed
  case loggingFailed
}

private actor RecordingUpdater: AppleConversionUpdating {
  private(set) var values: [ConversionUpdate] = []
  func update(_ value: ConversionUpdate) { values.append(value) }
}

private actor RecordingSink: ConversionEventSink {
  private(set) var events: [String] = []
  private(set) var loggedTags: [String] = []
  func recordConversionUpdate(schemaVersion: String, value: ConversionUpdate) {
    events.append("openmasu.conversion_value_updated")
  }
}

private actor FailingOnceUpdater: AppleConversionUpdating {
  private var failed = false

  func update(_ value: ConversionUpdate) async throws {
    if !failed {
      failed = true
      throw SyntheticConversionError.updateFailed
    }
  }
}

private actor FailingOnceSink: ConversionEventSink {
  private var failed = false

  func recordConversionUpdate(schemaVersion: String, value: ConversionUpdate) async throws {
    if !failed {
      failed = true
      throw SyntheticConversionError.loggingFailed
    }
  }
}
