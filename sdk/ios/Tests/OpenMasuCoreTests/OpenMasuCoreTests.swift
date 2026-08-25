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

  func testIdenticalDeterministicCommerceDuplicateIsIdempotentWithoutMaskingSequenceConflicts() throws {
    let storage = try OpenMasuStorage(root: temporaryDirectory("commerce-queue-idempotency"))
    let installationId = "installation:synthetic-commerce-queue"
    let transactionId = "transaction:synthetic-commerce-queue"
    let payload = try EventFactory.json([
      "event_name": "purchase",
      "transaction_id": transactionId,
      "amount_unscaled": "1250",
      "amount_scale": 2,
      "currency": "USD",
      "financial_status": "settled",
      "installation_id": installationId,
    ])
    let eventId = EventFactory.commerceEventIdentifier(
      eventName: "purchase", installationId: installationId, transactionId: transactionId,
      originalTransactionId: nil, amountUnscaled: "1250", amountScale: 2, currency: "USD"
    )
    let original = QueuedEvent(
      eventId: eventId, eventName: "purchase", processingPurposeId: "revenue_measurement",
      payloadJson: payload, occurredAt: "2026-08-20T00:00:00.000Z",
      processingSequence: 1, enqueuedAtMs: 1
    )
    let retry = QueuedEvent(
      eventId: eventId, eventName: "purchase", processingPurposeId: "revenue_measurement",
      payloadJson: payload, occurredAt: "2026-08-20T00:00:01.000Z",
      processingSequence: 2, enqueuedAtMs: 2
    )
    try storage.enqueue(original)
    try storage.enqueue(retry)
    XCTAssertEqual(try storage.pending(), [original])

    let otherTransactionId = "transaction:synthetic-commerce-sequence-conflict"
    let otherPayload = try EventFactory.json([
      "event_name": "purchase",
      "transaction_id": otherTransactionId,
      "amount_unscaled": "500",
      "amount_scale": 2,
      "currency": "USD",
      "financial_status": "settled",
      "installation_id": installationId,
    ])
    let sequenceConflict = QueuedEvent(
      eventId: EventFactory.commerceEventIdentifier(
        eventName: "purchase", installationId: installationId, transactionId: otherTransactionId,
        originalTransactionId: nil, amountUnscaled: "500", amountScale: 2, currency: "USD"
      ),
      eventName: "purchase", processingPurposeId: "revenue_measurement",
      payloadJson: otherPayload, occurredAt: "2026-08-20T00:00:02.000Z",
      processingSequence: 1, enqueuedAtMs: 3
    )
    assertQueueInsertFailed { try storage.enqueue(sequenceConflict) }
  }

  func testDeterministicCommerceDuplicateWithDifferentPayloadStillFails() throws {
    let storage = try OpenMasuStorage(root: temporaryDirectory("commerce-queue-conflict"))
    let installationId = "installation:synthetic-commerce-conflict"
    let transactionId = "transaction:synthetic-commerce-conflict"
    let eventId = EventFactory.commerceEventIdentifier(
      eventName: "purchase", installationId: installationId, transactionId: transactionId,
      originalTransactionId: nil, amountUnscaled: "1250", amountScale: 2, currency: "USD"
    )
    let originalPayload = try EventFactory.json([
      "event_name": "purchase", "transaction_id": transactionId,
      "amount_unscaled": "1250", "amount_scale": 2, "currency": "USD",
      "financial_status": "settled", "installation_id": installationId,
    ])
    try storage.enqueue(QueuedEvent(
      eventId: eventId, eventName: "purchase", processingPurposeId: "revenue_measurement",
      payloadJson: originalPayload, occurredAt: "2026-08-20T00:00:00.000Z",
      processingSequence: 1, enqueuedAtMs: 1
    ))

    let conflictingPayload = try EventFactory.json([
      "event_name": "purchase", "transaction_id": transactionId,
      "amount_unscaled": "1251", "amount_scale": 2, "currency": "USD",
      "financial_status": "settled", "installation_id": installationId,
    ])
    assertQueueInsertFailed {
      try storage.enqueue(QueuedEvent(
        eventId: eventId, eventName: "purchase", processingPurposeId: "revenue_measurement",
        payloadJson: conflictingPayload, occurredAt: "2026-08-20T00:00:01.000Z",
        processingSequence: 2, enqueuedAtMs: 2
      ))
    }
    XCTAssertEqual(try storage.count(), 1)
  }

  func testCallerSuppliedAdRevenueDuplicateEventIdStillFails() throws {
    let storage = try OpenMasuStorage(root: temporaryDirectory("ad-revenue-queue-conflict"))
    let eventId = "impression:synthetic-ad-revenue-duplicate"
    let originalPayload = try EventFactory.json([
      "event_name": "ad_revenue", "impression_id": eventId,
      "amount_unscaled": "100", "amount_scale": 6, "currency": "USD",
    ])
    try storage.enqueue(QueuedEvent(
      eventId: eventId, eventName: "ad_revenue", processingPurposeId: "revenue_measurement",
      payloadJson: originalPayload, occurredAt: "2026-08-20T00:00:00.000Z",
      processingSequence: 1, enqueuedAtMs: 1
    ))
    assertQueueInsertFailed {
      try storage.enqueue(QueuedEvent(
        eventId: eventId, eventName: "ad_revenue", processingPurposeId: "revenue_measurement",
        payloadJson: originalPayload, occurredAt: "2026-08-20T00:00:01.000Z",
        processingSequence: 2, enqueuedAtMs: 2
      ))
    }

    let conflictingPayload = try EventFactory.json([
      "event_name": "ad_revenue", "impression_id": eventId,
      "amount_unscaled": "101", "amount_scale": 6, "currency": "USD",
    ])
    assertQueueInsertFailed {
      try storage.enqueue(QueuedEvent(
        eventId: eventId, eventName: "ad_revenue", processingPurposeId: "revenue_measurement",
        payloadJson: conflictingPayload, occurredAt: "2026-08-20T00:00:02.000Z",
        processingSequence: 3, enqueuedAtMs: 3
      ))
    }
    XCTAssertEqual(try storage.count(), 1)
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

  func testDLA19UniversalLinkAndBareURLHaveIdenticalSynchronousDelivery() async throws {
    let transport = RecordingTransport(deliveryFailure: true)
    let sdk = try OpenMasuSDK(
      configuration: configuration(defaultEnabled: true, deepLinkHosts: ["links.synthetic.invalid"], deepLinkSchemes: ["openmasu-synthetic"]),
      storageRoot: temporaryDirectory("deep-link"),
      transport: transport
    )
    let recorder = DeepLinkRecorder()
    sdk.setDeepLinkListener { value in recorder.append(value) }
    let url = try XCTUnwrap(URL(string: "https://links.synthetic.invalid/r/Synthetic123/shop/item/53?dlp_code=abc&next=https://invalid"))
    let caller = Thread.current
    XCTAssertTrue(sdk.handleDeepLink(url))
    let activity = NSUserActivity(activityType: NSUserActivityTypeBrowsingWeb)
    activity.webpageURL = url
    XCTAssertTrue(sdk.handleDeepLink(activity))
    let (delivered, threads) = recorder.snapshot()
    XCTAssertEqual(delivered.count, 2)
    XCTAssertEqual(delivered[0], delivered[1])
    XCTAssertEqual(delivered[0].value, "/shop/item/53")
    XCTAssertEqual(delivered[0].parameters, ["code": "abc"])
    XCTAssertTrue(threads.allSatisfy { $0 === caller })
    let rejectedURL = try XCTUnwrap(URL(string: "https://links.synthetic.invalid/r/Synthetic123/rejected/bad%21suffix"))
    XCTAssertTrue(sdk.handleDeepLink(rejectedURL))
    let (withRejected, _) = recorder.snapshot()
    XCTAssertNil(withRejected.last?.value)
    XCTAssertEqual(withRejected.last?.destinationStatus, "rejected")
    XCTAssertTrue(sdk.handleDeepLink(URL(string: "openmasu-synthetic://links.synthetic.invalid/r/Synthetic123/custom")!))
    let (withCustomScheme, _) = recorder.snapshot()
    XCTAssertEqual(withCustomScheme.last?.openSource, "custom_scheme")
    XCTAssertEqual(withCustomScheme.last?.value, "/custom")
    XCTAssertFalse(sdk.handleDeepLink(URL(string: "https://unconfigured.invalid/r/Synthetic123/shop")!))
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

  func testCommerceHelpersEmitScopedNonRevealingIdempotentRevenueEvents() async throws {
    let transport = RecordingTransport(deliveryFailure: true)
    let sdk = try OpenMasuSDK(
      configuration: configuration(defaultEnabled: true),
      storageRoot: temporaryDirectory("commerce-events"),
      transport: transport
    )
    let transactionId = "transaction:synthetic-49"
    for operation in [
      { try await sdk.trackSettledPurchase(transactionId: transactionId, amountUnscaled: "1250", amountScale: 2, currency: "USD") },
      { try await sdk.trackSettledPurchase(transactionId: transactionId, amountUnscaled: "1250", amountScale: 2, currency: "USD") },
      { try await sdk.trackSettledPurchase(transactionId: transactionId, amountUnscaled: "1251", amountScale: 2, currency: "USD") },
      { try await sdk.trackRefund(transactionId: transactionId, originalTransactionId: transactionId, amountUnscaled: "1250", amountScale: 2, currency: "USD") },
    ] as [() async throws -> Void] {
      do {
        try await operation()
        XCTFail("synthetic delivery failure must retain the commerce event")
      } catch { XCTAssertEqual(error as? OpenMasuError, .transport(503)) }
    }

    let commerce = try await sdk.pendingEvents()
    XCTAssertEqual(commerce.count, 3)
    XCTAssertEqual(Set(commerce.map(\.processingPurposeId)), ["revenue_measurement"])
    XCTAssertEqual(Set(commerce.map(\.eventId)).count, 3)
    XCTAssertTrue(commerce.allSatisfy { !$0.eventId.contains(transactionId) })
    let payloads = try commerce.map { event -> (QueuedEvent, [String: Any]) in
      let data = try XCTUnwrap(event.payloadJson.data(using: .utf8))
      let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
      return (event, payload)
    }
    let purchase = try XCTUnwrap(payloads.first {
      $0.1["event_name"] as? String == "purchase" &&
      $0.1["transaction_id"] as? String == transactionId &&
      $0.1["financial_status"] as? String == "settled" &&
      $0.1["amount_unscaled"] as? String == "1250"
    })
    let purchaseInstallationId = try XCTUnwrap(purchase.1["installation_id"] as? String)
    XCTAssertEqual(
      purchase.0.eventId,
      EventFactory.commerceEventIdentifier(
        eventName: "purchase", installationId: purchaseInstallationId,
        transactionId: transactionId, originalTransactionId: nil,
        amountUnscaled: "1250", amountScale: 2, currency: "USD"
      )
    )
    XCTAssertEqual(
      EventFactory.commerceEventIdentifier(
        eventName: "purchase", installationId: "installation:synthetic-49",
        transactionId: transactionId, originalTransactionId: nil,
        amountUnscaled: "1250", amountScale: 2, currency: "USD"
      ),
      "event:commerce:74aaf116d61cb4d92cd254eba0a3ef096d6f877182952d450dd9f89e9aab6cff"
    )
    let vector = EventFactory.commerceEventIdentifier(
      eventName: "purchase", installationId: "installation:synthetic-49",
      transactionId: transactionId, originalTransactionId: nil,
      amountUnscaled: "1250", amountScale: 2, currency: "USD"
    )
    let fieldChanges = [
      EventFactory.commerceEventIdentifier(eventName: "refund", installationId: "installation:synthetic-49", transactionId: transactionId, originalTransactionId: nil, amountUnscaled: "1250", amountScale: 2, currency: "USD"),
      EventFactory.commerceEventIdentifier(eventName: "purchase", installationId: "installation:other-49", transactionId: transactionId, originalTransactionId: nil, amountUnscaled: "1250", amountScale: 2, currency: "USD"),
      EventFactory.commerceEventIdentifier(eventName: "purchase", installationId: "installation:synthetic-49", transactionId: "transaction:other-49", originalTransactionId: nil, amountUnscaled: "1250", amountScale: 2, currency: "USD"),
      EventFactory.commerceEventIdentifier(eventName: "purchase", installationId: "installation:synthetic-49", transactionId: transactionId, originalTransactionId: "transaction:original-49", amountUnscaled: "1250", amountScale: 2, currency: "USD"),
      EventFactory.commerceEventIdentifier(eventName: "purchase", installationId: "installation:synthetic-49", transactionId: transactionId, originalTransactionId: nil, amountUnscaled: "1251", amountScale: 2, currency: "USD"),
      EventFactory.commerceEventIdentifier(eventName: "purchase", installationId: "installation:synthetic-49", transactionId: transactionId, originalTransactionId: nil, amountUnscaled: "1250", amountScale: 3, currency: "USD"),
      EventFactory.commerceEventIdentifier(eventName: "purchase", installationId: "installation:synthetic-49", transactionId: transactionId, originalTransactionId: nil, amountUnscaled: "1250", amountScale: 2, currency: "JPY"),
    ]
    XCTAssertTrue(fieldChanges.allSatisfy { $0 != vector })
    XCTAssertNotNil(purchase.1["installation_id"])
    let refund = try XCTUnwrap(payloads.first { $0.1["event_name"] as? String == "refund" })
    XCTAssertEqual(refund.1["original_transaction_id"] as? String, transactionId)
    XCTAssertEqual(refund.1["financial_status"] as? String, "settled")
    XCTAssertNil(refund.1["correction_target_record_id"])
    XCTAssertTrue(payloads.allSatisfy { $0.1["financial_status"] as? String == "settled" })
    XCTAssertTrue(payloads.allSatisfy { $0.1["installation_id"] != nil })
    let changed = try XCTUnwrap(payloads.first { $0.1["amount_unscaled"] as? String == "1251" })
    XCTAssertNotEqual(changed.0.eventId, purchase.0.eventId)
  }

  func testSettledCommerceHelpersRejectNegativeMoneyAndLegacyHelpersPreserveWireBehavior() async throws {
    let transport = RecordingTransport(deliveryFailure: true)
    let sdk = try OpenMasuSDK(
      configuration: configuration(defaultEnabled: true),
      storageRoot: temporaryDirectory("commerce-validation"),
      transport: transport
    )
    do {
      try await sdk.trackSettledPurchase(
        transactionId: "transaction:negative-49", amountUnscaled: "-1", amountScale: 2, currency: "USD"
      )
      XCTFail("negative purchase money must be rejected")
    } catch { XCTAssertEqual(error as? OpenMasuError, .invalidMoney) }
    do {
      try await sdk.trackRefund(
        transactionId: "refund:negative-49", originalTransactionId: "transaction:negative-49",
        amountUnscaled: "-1", amountScale: 2, currency: "USD"
      )
      XCTFail("negative refund money must be rejected")
    } catch { XCTAssertEqual(error as? OpenMasuError, .invalidMoney) }
    let pendingCount = try await sdk.pendingCount()
    XCTAssertEqual(pendingCount, 0)

    for operation in [
      { try await sdk.trackPurchase(transactionId: "transaction:legacy-49", amountUnscaled: "100", amountScale: 2, currency: "USD") },
      { try await sdk.trackPurchase(transactionId: "transaction:legacy-49", amountUnscaled: "100", amountScale: 2, currency: "USD") },
      { try await sdk.trackPurchase(transactionId: "transaction:pending-49", amountUnscaled: "100", amountScale: 2, currency: "USD", financialStatus: "pending") },
      {
        try await sdk.trackRefund(
          transactionId: "refund:legacy-49", originalTransactionId: "transaction:legacy-49",
          correctionTargetRecordId: "record:legacy-49", amountUnscaled: "100", amountScale: 2, currency: "USD"
        )
      },
      {
        try await sdk.trackRefund(
          transactionId: "refund:legacy-49", originalTransactionId: "transaction:legacy-49",
          correctionTargetRecordId: "record:legacy-49", amountUnscaled: "100", amountScale: 2, currency: "USD"
        )
      },
    ] as [() async throws -> Void] {
      do {
        try await operation()
        XCTFail("synthetic delivery failure must retain the legacy event")
      } catch { XCTAssertEqual(error as? OpenMasuError, .transport(503)) }
    }

    let pending = try await sdk.pendingEvents()
    XCTAssertEqual(pending.count, 5)
    let decoded = try pending.map { event -> (QueuedEvent, [String: Any]) in
      let data = try XCTUnwrap(event.payloadJson.data(using: .utf8))
      let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
      return (event, payload)
    }
    XCTAssertTrue(decoded.allSatisfy { $0.0.processingPurposeId == "revenue_measurement" })
    XCTAssertTrue(decoded.allSatisfy { $0.1["installation_id"] == nil })
    XCTAssertTrue(decoded.allSatisfy { $0.0.eventId.hasPrefix("event:") && !$0.0.eventId.hasPrefix("event:commerce:") })

    let purchases = decoded.filter { $0.1["event_name"] as? String == "purchase" }
    XCTAssertEqual(purchases.count, 3)
    XCTAssertEqual(Set(purchases.map { $0.0.eventId }).count, 3)
    XCTAssertEqual(purchases.filter { $0.1["financial_status"] as? String == "settled" }.count, 2)
    XCTAssertEqual(purchases.filter { $0.1["financial_status"] as? String == "pending" }.count, 1)
    XCTAssertTrue(purchases.allSatisfy { $0.1["correction_target_record_id"] == nil })

    let refunds = decoded.filter { $0.1["event_name"] as? String == "refund" }
    XCTAssertEqual(refunds.count, 2)
    XCTAssertEqual(Set(refunds.map { $0.0.eventId }).count, 2)
    XCTAssertTrue(refunds.allSatisfy { $0.1["financial_status"] as? String == "reversed" })
    XCTAssertTrue(refunds.allSatisfy { $0.1["correction_target_record_id"] as? String == "record:legacy-49" })
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

  private func configuration(defaultEnabled: Bool, deepLinkHosts: Set<String> = [], deepLinkSchemes: Set<String> = []) -> OpenMasuConfiguration {
    OpenMasuConfiguration(
      endpoint: URL(string: "http://127.0.0.1:1")!,
      sdkKeyId: "sdk-key:synthetic",
      sdkSecret: "synthetic-sdk-secret-32-bytes-long",
      collectionEnabledByDefault: defaultEnabled,
      deepLinkHosts: deepLinkHosts,
      deepLinkSchemes: deepLinkSchemes
    )
  }

  private func temporaryDirectory(_ name: String) -> URL {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("openmasu-\(name)-\(UUID().uuidString)", isDirectory: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: url) }
    return url
  }

  private func assertQueueInsertFailed(
    _ operation: () throws -> Void,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    XCTAssertThrowsError(try operation(), file: file, line: line) { error in
      guard let openMasuError = error as? OpenMasuError,
            case let .storage(message) = openMasuError
      else {
        return XCTFail("expected OpenMasuError.storage, got \(error)", file: file, line: line)
      }
      XCTAssertTrue(message.hasPrefix("queue_insert_failed:"), message, file: file, line: line)
    }
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

private final class DeepLinkRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var values: [OpenMasuDeepLink] = []
  private var threads: [Thread] = []
  func append(_ value: OpenMasuDeepLink) { lock.lock(); values.append(value); threads.append(Thread.current); lock.unlock() }
  func snapshot() -> ([OpenMasuDeepLink], [Thread]) { lock.lock(); defer { lock.unlock() }; return (values, threads) }
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
