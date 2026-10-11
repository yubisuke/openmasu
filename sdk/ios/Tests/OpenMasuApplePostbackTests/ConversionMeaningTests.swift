import Foundation
import XCTest
import OpenMasuCore
@testable import OpenMasuApplePostback

final class ConversionMeaningTests: XCTestCase {
  private let digest = "1f1d34137531516b47d84f489342966738e4a50d18110e9d3ced2dfc5202b5e0"
  private let now = Date(timeIntervalSince1970: 1_781_654_400) // Synthetic 2026 date inside the declaration.
  private func vectors() throws -> [String: Any] {
    let url = try XCTUnwrap(Bundle.module.url(forResource: "meaning", withExtension: "json"))
    return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
  }
  private func schema() throws -> ConversionMeaningSchema {
    try ConversionMeaningSchema.load(data: JSONSerialization.data(withJSONObject: vectors()["definition"]!),
      registeredVersion: "2.0.0", registeredDigest: digest)
  }
  private func root() -> URL {
    let value = FileManager.default.temporaryDirectory.appendingPathComponent("openmasu-meaning-\(UUID().uuidString)")
    addTeardownBlock { try? FileManager.default.removeItem(at: value) }
    return value
  }
  private func sdk(_ root: URL) throws -> OpenMasuSDK {
    try OpenMasuSDK(configuration: .init(endpoint: URL(string: "https://synthetic.example")!,
      sdkKeyId: "sdk:synthetic", sdkSecret: "synthetic-secret", conversionSchemaVersion: "2.0.0", conversionSchemaSha256: digest), storageRoot: root, transport: MeaningTransport())
  }

  func testSharedServerMeaningVectorsAndCanonicalRegisteredDigest() throws {
    let definition = try schema()
    XCTAssertEqual(try definition.digest, digest)
    let rows = try XCTUnwrap(vectors()["cases"] as? [[String: Any]])
    for row in rows {
      let value = try definition.evaluate(eventMask: row["mask"] as! Int, revenueUnscaled: Int64(row["revenue"] as! String)!)
      XCTAssertEqual(value.fineValue, row["fine"] as? Int, row["name"] as! String)
      XCTAssertEqual(value.coarseValue.rawValue, row["coarse"] as? String)
      XCTAssertEqual(value.lockPostback, row["lock"] as? Bool)
      XCTAssertEqual(value.conversionTypes, [.install])
    }
    let data = try JSONSerialization.data(withJSONObject: vectors()["definition"]!)
    XCTAssertThrowsError(try ConversionMeaningSchema.load(data: data, registeredVersion: "2.0.1", registeredDigest: digest))
    var invalid = try XCTUnwrap(vectors()["definition"] as? [String: Any])
    invalid["event_keys"] = ["purchase", "purchase"]
    XCTAssertThrowsError(try ConversionMeaningSchema.load(data: JSONSerialization.data(withJSONObject: invalid), registeredVersion: "2.0.0", registeredDigest: digest))
    invalid = try XCTUnwrap(vectors()["definition"] as? [String: Any])
    var invalidRevenue = try XCTUnwrap(invalid["revenue"] as? [String: Any])
    invalidRevenue["thresholds"] = ["0", "100\n"]
    invalid["revenue"] = invalidRevenue
    XCTAssertThrowsError(try ConversionMeaningSchema.load(data: JSONSerialization.data(withJSONObject: invalid), registeredVersion: "2.0.0", registeredDigest: digest))
  }

  func testOrderDuplicatesRestartAndWindowLocalLock() async throws {
    for reversed in [false, true] {
      let directory = root(), updater = MeaningUpdater()
      var host = try sdk(directory)
      var controller = MeaningConversionController(schema: try schema(), sdk: host, updater: updater)
      let events: [(String, String, String?)] = reversed ? [("payment-2", "purchase", "400"), ("payment-1", "purchase", "100"), ("onboarding", "onboarding_complete", nil)]
        : [("onboarding", "onboarding_complete", nil), ("payment-1", "purchase", "100"), ("payment-2", "purchase", "400")]
      for (index, event) in events.enumerated() {
        _ = try await controller.record(eventID: event.0, eventKey: event.1, revenueUnscaled: event.2, windowSequence: 0, consentGranted: true, now: now)
        let before = await updater.values.count
        _ = try await controller.record(eventID: event.0, eventKey: event.1, revenueUnscaled: event.2, windowSequence: 0, consentGranted: true, now: now)
        let after = await updater.values.count
        XCTAssertEqual(before, after, "duplicate must not update the platform or sum revenue twice")
        if index == 1 { // A new SDK/controller reads the same SQLite state, not a shared in-memory array.
          host = try sdk(directory)
          controller = MeaningConversionController(schema: try schema(), sdk: host, updater: updater)
        }
      }
      let final = await updater.values.last
      XCTAssertEqual(final?.fineValue, 11)
      XCTAssertEqual(final?.lockPostback, true)
      let before = await updater.values.count
      _ = try await controller.record(eventID: "after-lock", eventKey: "purchase", revenueUnscaled: "900", windowSequence: 0, consentGranted: true, now: now)
      let after = await updater.values.count
      XCTAssertEqual(before, after)
      let next = try await controller.record(eventID: "new-window", eventKey: "purchase", revenueUnscaled: "100", windowSequence: 1, consentGranted: true, now: now)
      XCTAssertEqual(next.fineValue, 6)
      XCTAssertFalse(next.lockPostback, "a window lock is not an app-lifetime lock")
      let pending = try await host.pendingCount()
      XCTAssertEqual(pending, 0, "local meaning evaluation does not upload events")
    }
  }

  func testFailedUpdateDoesNotCommitAndConflictingRetryIsRejected() async throws {
    let updater = MeaningUpdater(failFirst: true), host = try sdk(root())
    let controller = MeaningConversionController(schema: try schema(), sdk: host, updater: updater)
    do {
      _ = try await controller.record(eventID: "payment", eventKey: "purchase", revenueUnscaled: "100", windowSequence: 0, consentGranted: true, now: now)
      XCTFail("synthetic failure expected")
    } catch { XCTAssertEqual(error as? OpenMasuError, .conversionSchema("synthetic_platform_failure")) }
    let value = try await controller.record(eventID: "payment", eventKey: "purchase", revenueUnscaled: "100", windowSequence: 0, consentGranted: true, now: now)
    XCTAssertEqual(value.fineValue, 6)
    do {
      _ = try await controller.record(eventID: "payment", eventKey: "purchase", revenueUnscaled: "101", windowSequence: 0, consentGranted: true, now: now)
      XCTFail("same local operation cannot change meaning")
    } catch { XCTAssertEqual(error as? OpenMasuError, .conversionSchema("conversion_event_conflict")) }
  }

  func testWithdrawalDuringUpdateCannotResurrectStateAndSurvivesRestart() async throws {
    let directory = root()
    let persisted = try sdk(directory), started = expectation(description: "platform update entered")
    let updater = MeaningUpdater(started: started)
    let controller = MeaningConversionController(schema: try schema(), sdk: persisted, updater: updater)
    let operation = Task { try await controller.record(eventID: "payment", eventKey: "purchase", revenueUnscaled: "100",
      windowSequence: 0, consentGranted: true, now: now) }
    await fulfillment(of: [started], timeout: 5)
    try await persisted.updateConsent(state: "withdrawn", policyVersion: "synthetic-v1")
    await updater.resume()
    do { _ = try await operation.value; XCTFail("revoked operation cannot commit") }
    catch { XCTAssertEqual(error as? OpenMasuError, .conversionSchema("conversion_context_changed")) }
    let restarted = try sdk(directory)
    do { _ = try await restarted.beginAppleConversionState(consentGranted: true, schemaVersion: "2.0.0", schemaDigest: digest); XCTFail("persisted consent barrier expected") }
    catch { XCTAssertEqual(error as? OpenMasuError, .conversionSchema("conversion_consent_required")) }
    try await restarted.updateConsent(state: "granted", policyVersion: "synthetic-v1")
    let lease = try await restarted.beginAppleConversionState(consentGranted: true, schemaVersion: "2.0.0", schemaDigest: digest)
    XCTAssertNil(lease.state, "withdrawal removed meaning and dedupe state")
    await restarted.cancelAppleConversionState(lease)
  }
}

private actor MeaningUpdater: AppleConversionUpdating {
  private(set) var values: [ConversionUpdate] = []
  private var failFirst: Bool
  private var started: XCTestExpectation?
  private var continuation: CheckedContinuation<Void, Never>?
  init(failFirst: Bool = false, started: XCTestExpectation? = nil) { self.failFirst = failFirst; self.started = started }
  func update(_ value: ConversionUpdate) async throws {
    if failFirst { failFirst = false; throw OpenMasuError.conversionSchema("synthetic_platform_failure") }
    if started != nil { await withCheckedContinuation { continuation in self.continuation = continuation; started?.fulfill(); started = nil } }
    values.append(value)
  }
  func resume() { continuation?.resume(); continuation = nil }
}
private actor MeaningTransport: OpenMasuTransport {
  func enroll(installationId: String) async throws -> InstallationCredential { .init(keyId: "synthetic-key", secret: "synthetic-secret") }
  func deliver(credential: InstallationCredential, events: [QueuedEvent]) async throws {}
  func deleteInstallation(credential: InstallationCredential, installationId: String) async throws {}
}
