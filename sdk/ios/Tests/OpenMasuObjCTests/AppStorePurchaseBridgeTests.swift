import Foundation
import XCTest
import OpenMasuCore
@testable import OpenMasuObjC

final class AppStorePurchaseBridgeTests: XCTestCase {
  private let requestId = "d5aef779-9f67-40ba-b66a-13f78f0cce83"
  private let transaction = "syntheticHeader.syntheticPayload.syntheticSignature"

  func testPreparationRoundTripsPrivateNativeStateAndSubmissionIsOnlyPending() async throws {
    let (sdk, transport) = try await makeSDK()
    let first = await AppStorePurchaseBridge.prepare(
      sdk: sdk, productId: "synthetic.monthly", purchaseRequestId: requestId, consent: true
    )
    let retry = await AppStorePurchaseBridge.prepare(
      sdk: sdk, productId: "synthetic.monthly", purchaseRequestId: requestId, consent: true
    )
    XCTAssertEqual(first, retry, "the same request retains native retry identity")
    let fields = try query(first)
    XCTAssertEqual(Set(fields.keys), Set(["state", "prepared", "app_account_token"]))
    XCTAssertEqual(fields["state"], "prepared")
    let encoded = try XCTUnwrap(fields["prepared"])
    let prepared = try JSONDecoder().decode(
      OpenMasuPreparedAppStorePurchase.self, from: XCTUnwrap(Data(base64Encoded: encoded))
    )
    XCTAssertEqual(prepared.requestId, UUID(uuidString: requestId))
    XCTAssertEqual(fields["app_account_token"], prepared.appAccountToken.uuidString.lowercased())
    let response = await AppStorePurchaseBridge.submit(
      sdk: sdk, encodedPreparation: encoded, signedTransaction: transaction, consent: true
    )
    XCTAssertEqual(response, "state=pending")
    XCTAssertFalse(response.contains(transaction))
    let submissions = await transport.submissions
    let pending = try await sdk.pendingCount()
    XCTAssertEqual(submissions, 1)
    XCTAssertEqual(pending, 0, "protected purchase submission does not emit client-declared revenue")
  }

  func testMalformedPreparationConsentWithdrawalAndResetNeverSubmit() async throws {
    let (sdk, transport) = try await makeSDK()
    for invalid in ["not base64", Data("{}".utf8).base64EncodedString(), String(repeating: "a", count: 8_193)] {
      let result = await AppStorePurchaseBridge.submit(
        sdk: sdk, encodedPreparation: invalid, signedTransaction: transaction, consent: true
      )
      XCTAssertEqual(result, "state=not_submitted&error=invalid_purchase")
    }
    let result = await AppStorePurchaseBridge.prepare(
      sdk: sdk, productId: "synthetic.monthly", purchaseRequestId: requestId, consent: true
    )
    let encoded = try XCTUnwrap(query(result)["prepared"])
    try await sdk.updateConsent(state: "withdrawn", policyVersion: "synthetic-v1")
    let withdrawn = await AppStorePurchaseBridge.submit(
      sdk: sdk, encodedPreparation: encoded, signedTransaction: transaction, consent: true
    )
    XCTAssertEqual(withdrawn, "state=not_submitted&error=consent_required")
    try await sdk.updateConsent(state: "granted", policyVersion: "synthetic-v1")
    try await sdk.resetInstallationId()
    let reset = await AppStorePurchaseBridge.submit(
      sdk: sdk, encodedPreparation: encoded, signedTransaction: transaction, consent: true
    )
    XCTAssertEqual(reset, "state=not_submitted&error=context_changed")
    let submissions = await transport.submissions
    XCTAssertEqual(submissions, 0)
  }

  func testInvalidRequestAndFailuresUseClosedCodesWithoutEvidence() async throws {
    let (sdk, transport) = try await makeSDK()
    let invalid = await AppStorePurchaseBridge.prepare(
      sdk: sdk, productId: "synthetic.monthly", purchaseRequestId: "not-a-uuid", consent: true
    )
    XCTAssertEqual(invalid, "state=not_submitted&error=invalid_purchase")
    let preparations = await transport.preparations
    XCTAssertEqual(preparations, 0)
    XCTAssertEqual(AppStorePurchaseBridge.failure(OpenMasuError.transport(503)), "state=not_submitted&error=transport_failed")
    let errors: [Error] = [
      OpenMasuError.storage(transaction),
      NSError(domain: transaction, code: 1, userInfo: [NSLocalizedDescriptionKey: transaction]),
    ]
    for error in errors {
      XCTAssertEqual(AppStorePurchaseBridge.failure(error), "state=not_submitted&error=purchase_failed")
    }
  }

  private func query(_ value: String) throws -> [String: String] {
    var components = URLComponents()
    components.percentEncodedQuery = value
    let items = try XCTUnwrap(components.queryItems)
    return Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
  }

  private func makeSDK() async throws -> (OpenMasuSDK, SyntheticPurchaseBridgeTransport) {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("openmasu-bridge-\(UUID().uuidString)")
    addTeardownBlock { try? FileManager.default.removeItem(at: root) }
    let transport = SyntheticPurchaseBridgeTransport()
    let sdk = try OpenMasuSDK(
      configuration: .init(endpoint: URL(string: "https://synthetic.invalid")!, sdkKeyId: "synthetic-sdk", sdkSecret: "synthetic-secret"),
      storageRoot: root, transport: transport
    )
    try await sdk.initialize()
    return (sdk, transport)
  }
}

private actor SyntheticPurchaseBridgeTransport: OpenMasuAppStoreTransport {
  private(set) var preparations = 0
  private(set) var submissions = 0
  func enroll(installationId: String) async throws -> InstallationCredential {
    .init(keyId: "synthetic-\(installationId)", secret: "synthetic-secret")
  }
  func deliver(credential: InstallationCredential, events: [QueuedEvent]) async throws {}
  func deleteInstallation(credential: InstallationCredential, installationId: String) async throws {}
  func prepareAppStorePurchase(
    credential: InstallationCredential, installationId: String, productId: String,
    requestId: UUID, revenueMeasurementConsent: Bool
  ) async throws -> OpenMasuPreparedAppStorePurchase {
    preparations += 1
    return .init(
      intentId: UUID(uuidString: "7566d44d-b224-4470-a191-ef1f81454c73")!,
      appAccountToken: UUID(uuidString: "bff0a5d8-1787-46c8-a2a7-256cfad8aa55")!,
      requestId: requestId, productId: productId, environment: .sandbox,
      installationId: installationId, installationKeyId: credential.keyId
    )
  }
  func submitAppStorePurchase(
    credential: InstallationCredential, prepared: OpenMasuPreparedAppStorePurchase,
    signedTransaction: String, revenueMeasurementConsent: Bool
  ) async throws -> OpenMasuAppStoreSubmission {
    submissions += 1
    return .init(intentId: prepared.intentId)
  }
}
