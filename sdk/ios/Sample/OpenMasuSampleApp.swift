import Foundation
import OpenMasuAppleAds
import OpenMasuApplePostback
import OpenMasuCore
import StoreKit

/// Synthetic integration sketch used by the simulator build gate. Applications
/// provide their own endpoint and SDK key through deployment-private settings.
public actor OpenMasuSampleApp {
  private let sdk: OpenMasuSDK
  private let conversionValues: ConversionValueController

  public init(
    endpoint: URL,
    sdkKeyId: String,
    sdkSecret: String,
    schemaData: Data,
    registeredSchemaDigest: String
  ) throws {
    let schema = try ConversionSchemaRegistry(registeredDigests: [
      "openmasu-default-v1": registeredSchemaDigest,
    ]).load(data: schemaData)
    sdk = try OpenMasuSDK(
      configuration: OpenMasuConfiguration(
        endpoint: endpoint,
        sdkKeyId: sdkKeyId,
        sdkSecret: sdkSecret,
        conversionSchemaVersion: schema.schemaVersion,
        conversionSchemaSha256: schema.sha256
      ),
      tokenProvider: SystemAdServicesTokenProvider()
    )
    conversionValues = ConversionValueController(
      schema: schema,
      updater: SystemAppleConversionUpdater(),
      sink: SdkConversionEventSink(sdk: sdk)
    )
  }

  public func initialize() async throws { try await sdk.initialize() }

  public func completeTutorial() async throws {
    try await sdk.trackCustomEvent("tutorial_complete")
    _ = try await conversionValues.record(eventName: "tutorial_complete")
  }

  public func disableCollection() async throws { try await sdk.setCollectionEnabled(false) }
  public func resetInstallation() async throws { try await sdk.resetInstallationId() }

  /// The host persists requestId before this call and retries the same ID after a timeout.
  public func prepareAppStoreMeasurement(
    product: Product, requestId: UUID, revenueMeasurementConsent: Bool
  ) async throws -> OpenMasuPreparedAppStorePurchase {
    try await sdk.prepareAppStorePurchase(
      productId: product.id, requestId: requestId, revenueMeasurementConsent: revenueMeasurementConsent
    )
  }

  public nonisolated func appStorePurchaseOptions(
    prepared: OpenMasuPreparedAppStorePurchase
  ) -> Set<Product.PurchaseOption> {
    [.appAccountToken(prepared.appAccountToken)]
  }

  /// Call only for the corresponding host-owned purchase result. This does not finish
  /// the transaction, grant an entitlement, or send a second client purchase event.
  public func submitAppStoreMeasurement(
    result: VerificationResult<Transaction>, prepared: OpenMasuPreparedAppStorePurchase,
    revenueMeasurementConsent: Bool
  ) async throws -> OpenMasuAppStoreSubmission {
    guard case .verified(let transaction) = result,
          transaction.productID == prepared.productId,
          transaction.appAccountToken == prepared.appAccountToken
    else { throw OpenMasuError.invalidAttributes }
    return try await sdk.submitAppStorePurchase(
      prepared: prepared, signedTransaction: result.jwsRepresentation,
      revenueMeasurementConsent: revenueMeasurementConsent
    )
  }
}
