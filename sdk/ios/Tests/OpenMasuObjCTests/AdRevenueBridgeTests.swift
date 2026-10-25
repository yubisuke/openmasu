import Foundation
import XCTest
import OpenMasuCore
@testable import OpenMasuObjC

final class AdRevenueBridgeTests: XCTestCase {
  func testRevenueUsesPersistentQueueStableIdentityAndNativeConsentBarrier() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("openmasu-revenue-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let configuration = OpenMasuConfiguration(endpoint: URL(string: "https://synthetic.invalid")!, sdkKeyId: "synthetic", sdkSecret: "synthetic")
    let transport = OfflineRevenueTransport()
    let sdk = try OpenMasuSDK(configuration: configuration, storageRoot: root, transport: transport)
    // Offline flush fails after persistence; no network request is made.
    try? await sdk.initialize()
    try? await sdk.updateConsent(state: "granted", policyVersion: "synthetic-levelplay")
    let impression = "impression:" + String(repeating: "a", count: 64)
    for _ in 0..<2 {
      try? await AdRevenueBridge.enqueue(sdk: sdk, impressionId: impression, amount: "1250000", precision: "exact",
        network: "synthetic-network", adUnitId: "synthetic-unit", mediationProvider: "unity-levelplay", format: "rewarded")
    }
    let reopened = try OpenMasuSDK(configuration: configuration, storageRoot: root, transport: transport)
    let revenue = try await reopened.pendingEvents().filter { $0.eventName == "ad_revenue" }
    XCTAssertEqual(revenue.count, 1)
    let event = try XCTUnwrap(revenue.first)
    let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(event.payloadJson.utf8)) as? [String: Any])
    XCTAssertEqual(event.eventId, impression)
    XCTAssertEqual(payload["impression_id"] as? String, impression)
    XCTAssertEqual(payload["amount_unscaled"] as? String, "1250000")
    XCTAssertEqual(payload["mediation_provider"] as? String, "unity-levelplay")
    XCTAssertEqual(payload["revenue_source"] as? String, "client_estimated")
    for amount in ["", "NaN", "-1", "1.2", "01"] {
      do {
        try await AdRevenueBridge.enqueue(sdk: reopened, impressionId: impression, amount: amount, precision: "exact",
          network: "synthetic-network", adUnitId: "synthetic-unit", mediationProvider: "unity-levelplay", format: "rewarded")
        XCTFail("invalid native money accepted")
      } catch { XCTAssertEqual(error as? OpenMasuError, .invalidAttributes) }
    }
    try? await reopened.updateConsent(state: "withdrawn", policyVersion: "synthetic-levelplay")
    try? await AdRevenueBridge.enqueue(sdk: reopened, impressionId: impression, amount: "1250000", precision: "exact",
      network: "synthetic-network", adUnitId: "synthetic-unit", mediationProvider: "unity-levelplay", format: "rewarded")
    let after = try await reopened.pendingEvents()
    XCTAssertFalse(after.contains { $0.eventName == "ad_revenue" })
    XCTAssertTrue(after.allSatisfy { $0.eventName == "consent_changed" })
  }
}

private actor OfflineRevenueTransport: OpenMasuTransport {
  func enroll(installationId: String) async throws -> InstallationCredential {
    .init(keyId: "synthetic-key", secret: "synthetic-secret")
  }
  func deliver(credential: InstallationCredential, events: [QueuedEvent]) async throws { throw OpenMasuError.transport(503) }
  func deleteInstallation(credential: InstallationCredential, installationId: String) async throws {}
}
