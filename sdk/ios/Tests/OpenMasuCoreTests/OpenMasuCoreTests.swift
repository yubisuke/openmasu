import Foundation
import XCTest
@testable import OpenMasuCore
#if os(macOS)
import Darwin
#endif

final class OpenMasuCoreTests: XCTestCase {
  func testM4A20SharedSigningVectors() throws {
    let vectorURL = findRepositoryFile("sdk/signing-vectors.json")
    let object = try JSONSerialization.jsonObject(with: Data(contentsOf: vectorURL)) as! [String: Any]
    let vectors = object["vectors"] as! [[String: Any]]
    XCTAssertGreaterThanOrEqual(vectors.count, 2)
    for vector in vectors {
      let body = Data((vector["body"] as! String).utf8)
      let installationKeyId = (vector["installation_key_id"] as! String)
      let canonical = SdkRequestSigner.canonical(
        method: (vector["method"] as! String).lowercased(),
        path: vector["path"] as! String,
        sdkKeyId: vector["sdk_key_id"] as! String,
        installationKeyId: installationKeyId == "-" ? nil : installationKeyId,
        timestampMs: (vector["timestamp_ms"] as! NSNumber).int64Value,
        nonce: vector["nonce"] as! String,
        body: body
      )
      XCTAssertEqual(canonical, vector["canonical"] as? String)
      XCTAssertEqual(SdkRequestSigner.sha256(body), vector["body_sha256"] as? String)
      XCTAssertEqual(
        SdkRequestSigner.sign(secret: vector["secret"] as! String, canonical: canonical),
        vector["signature"] as? String
      )
    }
  }

  func testM4A21QueueSurvivesReopenWithoutDuplicates() throws {
    let root = temporaryDirectory("queue")
    do {
      let storage = try OpenMasuStorage(root: root)
      for index in 0..<1_000 {
        try storage.enqueue(QueuedEvent(
          eventId: "event:\(index)", eventName: "custom_event", processingPurposeId: "analytics",
          payloadJson: "{\"event_name\":\"custom_event\",\"event_key\":\"synthetic\",\"installation_id\":\"installation:synthetic\"}",
          occurredAt: "2026-08-20T00:00:00.000Z", processingSequence: Int64(index + 1), enqueuedAtMs: Int64(index)
        ))
      }
      XCTAssertEqual(try storage.count(), 1_000)
    }
    let reopened = try OpenMasuStorage(root: root)
    let events = try reopened.pending(limit: 2_000)
    XCTAssertEqual(events.count, 1_000)
    XCTAssertEqual(Set(events.map(\.eventId)).count, 1_000)
    // SQLite commits survive process death. Abrupt power loss between WAL
    // fsyncs remains outside this gate, as documented by M4-D-22.
  }

  #if os(macOS)
  func testM4A21QueueSurvivesSigkillAndInterruptedWriter() throws {
    guard let probePath = ProcessInfo.processInfo.environment["OPENMASU_QUEUE_CRASH_PROBE"] else {
      throw XCTSkip("OPENMASU_QUEUE_CRASH_PROBE is supplied by the pinned macOS CI gate")
    }
    let stableRoot = temporaryDirectory("sigkill-stable")
    let stable = try startCrashProbe(executable: probePath, mode: "stable", root: stableRoot)
    XCTAssertEqual(kill(stable.processIdentifier, SIGKILL), 0)
    stable.waitUntilExit()
    let stableEvents = try OpenMasuStorage(root: stableRoot).pending(limit: 2_000)
    XCTAssertEqual(stableEvents.count, 1_000)
    XCTAssertEqual(Set(stableEvents.map(\.eventId)).count, 1_000)

    let interruptedRoot = temporaryDirectory("sigkill-write")
    let interrupted = try startCrashProbe(executable: probePath, mode: "interrupted", root: interruptedRoot)
    XCTAssertEqual(kill(interrupted.processIdentifier, SIGKILL), 0)
    interrupted.waitUntilExit()
    let interruptedEvents = try OpenMasuStorage(root: interruptedRoot).pending(limit: 20_000)
    XCTAssertGreaterThanOrEqual(interruptedEvents.count, 100)
    XCTAssertLessThanOrEqual(interruptedEvents.count, 10_000)
    XCTAssertEqual(Set(interruptedEvents.map(\.eventId)).count, interruptedEvents.count)
    // Committed WAL pages survive process death. Abrupt power loss between
    // fsyncs under synchronous=NORMAL is intentionally outside this gate.
  }
  #endif

  func testM4A22DisabledBeforeInitializeDoesNoIO() async throws {
    let transport = RecordingTransport(deliveryFailure: false)
    let token = CountingTokenProvider()
    let sdk = try OpenMasuSDK(
      configuration: configuration(defaultEnabled: false),
      storageRoot: temporaryDirectory("disabled"),
      transport: transport,
      tokenProvider: token
    )
    try await sdk.initialize()
    let callCount = await transport.callCount()
    XCTAssertEqual(callCount, 0)
    XCTAssertEqual(token.count, 0)
    let pendingCount = try await sdk.pendingCount()
    XCTAssertEqual(pendingCount, 0)
  }

  func testM4A22ExplicitDisableDoesNoNetworkOrTokenIO() async throws {
    let transport = RecordingTransport(deliveryFailure: false)
    let token = CountingTokenProvider(value: "synthetic-adservices-token")
    let sdk = try OpenMasuSDK(
      configuration: configuration(defaultEnabled: true),
      storageRoot: temporaryDirectory("explicit-disabled"),
      transport: transport,
      tokenProvider: token
    )
    try await sdk.setCollectionEnabled(false)
    try await sdk.initialize()
    let callCount = await transport.callCount()
    XCTAssertEqual(callCount, 0)
    XCTAssertEqual(token.count, 0)
    let pendingCount = try await sdk.pendingCount()
    XCTAssertEqual(pendingCount, 0)
  }

  func testM4A22InfoPlistDefaultDisabledWinsBeforeInitialize() throws {
    let bundleRoot = temporaryDirectory("plist-default").appendingPathComponent("Synthetic.bundle")
    let contents = bundleRoot.appendingPathComponent("Contents")
    try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
    let info: [String: Any] = [
      "CFBundleIdentifier": "dev.openmasu.synthetic-default",
      "CFBundleName": "OpenMasuSyntheticDefault",
      "CFBundlePackageType": "BNDL",
      "OpenMasuCollectionEnabledDefault": false,
    ]
    let data = try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
    try data.write(to: contents.appendingPathComponent("Info.plist"))
    let bundle = try XCTUnwrap(Bundle(url: bundleRoot))
    XCTAssertFalse(OpenMasuSDK.collectionDefault(bundle: bundle, fallback: true))
  }

  func testM4A22WithdrawalAndResetAreFailClosed() async throws {
    let transport = RecordingTransport(deliveryFailure: true)
    let token = CountingTokenProvider(value: "synthetic-adservices-token")
    let sdk = try OpenMasuSDK(
      configuration: configuration(defaultEnabled: true),
      storageRoot: temporaryDirectory("lifecycle"),
      transport: transport,
      tokenProvider: token
    )
    do { try await sdk.initialize(); XCTFail("initialize should retain the event after transport failure") }
    catch { XCTAssertEqual(error as? OpenMasuError, .transport(503)) }
    do { try await sdk.startSession(); XCTFail("session should remain queued after transport failure") }
    catch { XCTAssertEqual(error as? OpenMasuError, .transport(503)) }
    do { try await sdk.trackCustomEvent("tutorial_complete"); XCTFail("event should remain queued after transport failure") }
    catch { XCTAssertEqual(error as? OpenMasuError, .transport(503)) }
    do {
      try await sdk.updateConsent(state: "withdrawn", policyVersion: "policy-synthetic-v1")
      XCTFail("consent event should remain queued after transport failure")
    } catch { XCTAssertEqual(error as? OpenMasuError, .transport(503)) }
    let remaining = try await sdk.pendingEvents()
    XCTAssertEqual(Set(remaining.map(\.eventName)), ["consent_changed"])
    XCTAssertEqual(token.count, 1)

    await transport.setDeliveryFailure(false)
    try await sdk.resetInstallationId()
    XCTAssertEqual(token.count, 1, "reset must not fetch another AdServices token")
    let deleteCount = await transport.deleteCount()
    XCTAssertEqual(deleteCount, 1)
    let deliveredPayloads = await transport.deliveredPayloads()
    let resetPayloads = deliveredPayloads.flatMap { $0 }.map(\.payloadJson)
    XCTAssertTrue(resetPayloads.contains { $0.contains("\"install_origin\":\"identifier_reset\"") })
    XCTAssertTrue(resetPayloads.contains { $0.contains("\"referrer_status\":\"not_applicable\"") })
  }

  func testM4A22ResetResumesAfterEnrollmentFailureWithoutASecondDeletion() async throws {
    let transport = RecordingTransport(deliveryFailure: false)
    let sdk = try OpenMasuSDK(
      configuration: configuration(defaultEnabled: true),
      storageRoot: temporaryDirectory("reset-retry"),
      transport: transport
    )
    try await sdk.initialize()
    await transport.failNextEnrollment()
    do {
      try await sdk.resetInstallationId()
      XCTFail("the synthetic enrollment failure must leave a resumable reset")
    } catch { XCTAssertEqual(error as? OpenMasuError, .transport(503)) }
    let pendingInstallationId = try await sdk.installationIdForMeasurement()
    let deleteCountAfterFailure = await transport.deleteCount()
    XCTAssertEqual(deleteCountAfterFailure, 1)
    try await sdk.resetInstallationId()
    let deleteCountAfterRetry = await transport.deleteCount()
    let resumedInstallationId = try await sdk.installationIdForMeasurement()
    XCTAssertEqual(deleteCountAfterRetry, 1)
    XCTAssertEqual(resumedInstallationId, pendingInstallationId)
  }

  func testM4A29RevenueReusesImpressionIdentifierAsEventIdentifier() async throws {
    let transport = RecordingTransport(deliveryFailure: true)
    let sdk = try OpenMasuSDK(
      configuration: configuration(defaultEnabled: true),
      storageRoot: temporaryDirectory("revenue-event-id"),
      transport: transport
    )
    let identifier = "impression:018f3f5d-6c00-7000-8000-000000000001"
    do {
      try await sdk.enqueueAdRevenue(payload: [
        "event_name": "ad_revenue",
        "subject_scope": "installation_level",
        "installation_id": "installation:synthetic",
        "impression_id": identifier,
        "ad_unit_id": "ad-unit:synthetic",
        "ad_network": "Synthetic Network",
        "mediation_provider": "applovin-max",
        "amount_unscaled": "0",
        "amount_scale": 6,
        "currency": "USD",
        "currency_source": "reported",
        "revenue_source": "client_estimated",
        "revenue_precision": "undefined",
      ], eventId: identifier)
      XCTFail("failed delivery should retain the revenue event")
    } catch { XCTAssertEqual(error as? OpenMasuError, .transport(503)) }
    let pending = try await sdk.pendingEvents()
    XCTAssertEqual(pending.map(\.eventId), [identifier])
  }

  func testM4A23A26A27ManifestAndExcludedDirectory() throws {
    let root = temporaryDirectory("privacy")
    let storage = try OpenMasuStorage(root: root)
    _ = try storage.installationId()
    try storage.setCredential(.init(keyId: "installation-key:synthetic", secret: "synthetic-secret"))
    for index in 0..<10 {
      try storage.enqueue(QueuedEvent(
        eventId: "event:rotation:\(index)", eventName: "session_start", processingPurposeId: "analytics",
        payloadJson: "{\"event_name\":\"session_start\",\"installation_id\":\"installation:synthetic\",\"session_id\":\"session:\(index)\"}",
        occurredAt: "2026-08-20T00:00:00.000Z", processingSequence: Int64(index + 1), enqueuedAtMs: Int64(index)
      ))
      try storage.rotateQueueSegment()
    }
    try storage.setCredential(.init(keyId: "installation-key:synthetic-rewritten", secret: "synthetic-secret-rewritten"))
    XCTAssertEqual(try root.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    let resolvedRoot = root.standardizedFileURL.resolvingSymlinksInPath().path + "/"
    XCTAssertTrue(try storage.writtenFiles().allSatisfy {
      $0.standardizedFileURL.resolvingSymlinksInPath().path.hasPrefix(resolvedRoot)
    })

    let manifestURL = try XCTUnwrap(OpenMasuResources.privacyManifestURL)
    let manifest = try PropertyListSerialization.propertyList(from: Data(contentsOf: manifestURL), format: nil) as! [String: Any]
    XCTAssertEqual(manifest["NSPrivacyTracking"] as? Bool, false)
    XCTAssertNil(manifest["NSPrivacyTrackingDomains"])
  }

  private func configuration(defaultEnabled: Bool) -> OpenMasuConfiguration {
    OpenMasuConfiguration(
      endpoint: URL(string: "http://127.0.0.1:1")!,
      sdkKeyId: "sdk-key:synthetic",
      sdkSecret: "synthetic-sdk-secret-32-bytes-long",
      collectionEnabledByDefault: defaultEnabled
    )
  }

  private func temporaryDirectory(_ name: String) -> URL {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("openmasu-\(name)-\(UUID().uuidString)", isDirectory: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: url) }
    return url
  }

  private func findRepositoryFile(_ relativePath: String) -> URL {
    var candidate = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    while candidate.path != "/" {
      let value = candidate.appendingPathComponent(relativePath)
      if FileManager.default.fileExists(atPath: value.path) { return value }
      candidate.deleteLastPathComponent()
    }
    XCTFail("repository file not found: \(relativePath)")
    return URL(fileURLWithPath: relativePath)
  }

  #if os(macOS)
  private func startCrashProbe(executable: String, mode: String, root: URL) throws -> Process {
    let ready = root.appendingPathComponent("probe-ready")
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = [mode, root.path, ready.path]
    try process.run()
    let deadline = Date().addingTimeInterval(30)
    while !FileManager.default.fileExists(atPath: ready.path) && Date() < deadline {
      if !process.isRunning { throw OpenMasuError.storage("crash_probe_exited_early") }
      Thread.sleep(forTimeInterval: 0.01)
    }
    guard FileManager.default.fileExists(atPath: ready.path) else {
      if process.isRunning { process.terminate() }
      throw OpenMasuError.storage("crash_probe_ready_timeout")
    }
    return process
  }
  #endif
}

private actor RecordingTransport: OpenMasuTransport {
  private var calls = 0
  private var deletes = 0
  private var failDelivery: Bool
  private var enrollmentFailures = 0
  private var payloads: [[QueuedEvent]] = []

  init(deliveryFailure: Bool) { self.failDelivery = deliveryFailure }
  func enroll(installationId: String) async throws -> InstallationCredential {
    calls += 1
    if enrollmentFailures > 0 {
      enrollmentFailures -= 1
      throw OpenMasuError.transport(503)
    }
    return .init(keyId: "installation-key:synthetic", secret: "synthetic-installation-secret-32-bytes")
  }
  func deliver(credential: InstallationCredential, events: [QueuedEvent]) async throws {
    calls += 1
    payloads.append(events)
    if failDelivery { throw OpenMasuError.transport(503) }
  }
  func deleteInstallation(credential: InstallationCredential, installationId: String) async throws { calls += 1; deletes += 1 }
  func callCount() -> Int { calls }
  func deleteCount() -> Int { deletes }
  func deliveredPayloads() -> [[QueuedEvent]] { payloads }
  func setDeliveryFailure(_ value: Bool) { failDelivery = value }
  func failNextEnrollment() { enrollmentFailures += 1 }
}

private final class CountingTokenProvider: AdServicesTokenProviding, @unchecked Sendable {
  private let lock = NSLock()
  private let value: String?
  private var reads = 0
  init(value: String? = nil) { self.value = value }
  var count: Int { lock.lock(); defer { lock.unlock() }; return reads }
  func attributionToken() throws -> String? { lock.lock(); reads += 1; lock.unlock(); return value }
}
