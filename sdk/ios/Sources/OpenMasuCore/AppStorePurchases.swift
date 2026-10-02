import Foundation

public enum OpenMasuAppStoreEnvironment: String, Codable, Sendable {
  case sandbox = "Sandbox"
  case production = "Production"
}

/// Server-issued measurement preparation, not a purchase or an entitlement.
/// Treat this value as private; persist it only in the host application's protected retry state.
public struct OpenMasuPreparedAppStorePurchase: Codable, Equatable, Sendable {
  public let intentId: UUID
  public let appAccountToken: UUID
  public let requestId: UUID
  public let productId: String
  public let environment: OpenMasuAppStoreEnvironment
  public let installationId: String
  public let installationKeyId: String

  public init(
    intentId: UUID, appAccountToken: UUID, requestId: UUID, productId: String,
    environment: OpenMasuAppStoreEnvironment, installationId: String, installationKeyId: String
  ) {
    self.intentId = intentId
    self.appAccountToken = appAccountToken
    self.requestId = requestId
    self.productId = productId
    self.environment = environment
    self.installationId = installationId
    self.installationKeyId = installationKeyId
  }
}

public struct OpenMasuAppStoreSubmission: Equatable, Sendable {
  public enum State: String, Sendable { case pending }
  public let intentId: UUID
  public let state: State = .pending

  public init(intentId: UUID) { self.intentId = intentId }
}

/// Optional capability: existing custom event transports remain source-compatible.
public protocol OpenMasuAppStoreTransport: OpenMasuTransport {
  func prepareAppStorePurchase(
    credential: InstallationCredential, installationId: String, productId: String,
    requestId: UUID, revenueMeasurementConsent: Bool
  ) async throws -> OpenMasuPreparedAppStorePurchase
  func submitAppStorePurchase(
    credential: InstallationCredential, prepared: OpenMasuPreparedAppStorePurchase,
    signedTransaction: String, revenueMeasurementConsent: Bool
  ) async throws -> OpenMasuAppStoreSubmission
}

extension HmacHttpTransport {
  public func prepareAppStorePurchase(
    credential: InstallationCredential, installationId: String, productId: String,
    requestId: UUID, revenueMeasurementConsent: Bool
  ) async throws -> OpenMasuPreparedAppStorePurchase {
    guard revenueMeasurementConsent else { throw OpenMasuError.purchaseConsentRequired }
    try AppStorePurchaseValidation.product(productId)
    let body = Data(try EventFactory.json([
      "request_id": requestId.uuidString.lowercased(), "installation_id": installationId,
      "product_id": productId, "revenue_measurement_consent": true,
    ]).utf8)
    let response = try await request(path: "/v1/apple/purchases/prepare", body: body, credential: credential)
    guard response.status == 200 else { throw OpenMasuError.transport(response.status) }
    guard let value = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any],
          Set(value.keys) == Set(["intent_id", "app_account_token", "product_id", "environment", "state"]),
          value["state"] as? String == "prepared", value["product_id"] as? String == productId,
          let intent = value["intent_id"] as? String, let intentId = UUID(uuidString: intent),
          let token = value["app_account_token"] as? String, let appAccountToken = UUID(uuidString: token),
          let environmentValue = value["environment"] as? String,
          let environment = OpenMasuAppStoreEnvironment(rawValue: environmentValue)
    else { throw OpenMasuError.responseInvalid }
    return OpenMasuPreparedAppStorePurchase(
      intentId: intentId, appAccountToken: appAccountToken, requestId: requestId, productId: productId,
      environment: environment, installationId: installationId, installationKeyId: credential.keyId
    )
  }

  public func submitAppStorePurchase(
    credential: InstallationCredential, prepared: OpenMasuPreparedAppStorePurchase,
    signedTransaction: String, revenueMeasurementConsent: Bool
  ) async throws -> OpenMasuAppStoreSubmission {
    guard revenueMeasurementConsent else { throw OpenMasuError.purchaseConsentRequired }
    guard prepared.installationKeyId == credential.keyId else { throw OpenMasuError.purchaseContextChanged }
    try AppStorePurchaseValidation.signedTransaction(signedTransaction)
    let body = Data(try EventFactory.json([
      "intent_id": prepared.intentId.uuidString.lowercased(), "installation_id": prepared.installationId,
      "signed_transaction": signedTransaction, "revenue_measurement_consent": true,
    ]).utf8)
    let response = try await request(path: "/v1/apple/purchases/submit", body: body, credential: credential)
    guard response.status == 202 else { throw OpenMasuError.transport(response.status) }
    guard let value = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any],
          Set(value.keys) == Set(["intent_id", "state"]), value["state"] as? String == "pending",
          let intent = value["intent_id"] as? String, UUID(uuidString: intent) == prepared.intentId
    else { throw OpenMasuError.responseInvalid }
    return OpenMasuAppStoreSubmission(intentId: prepared.intentId)
  }
}

enum AppStorePurchaseValidation {
  static func product(_ value: String) throws {
    guard value.range(of: "^[A-Za-z0-9._-]{1,255}$", options: .regularExpression) != nil
    else { throw OpenMasuError.invalidAttributes }
  }

  static func signedTransaction(_ value: String) throws {
    // Bound and check the transport shape only; verification belongs to the server.
    guard value.utf8.count <= 256 * 1024,
          value.range(of: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$", options: .regularExpression) != nil
    else { throw OpenMasuError.invalidAttributes }
  }
}
