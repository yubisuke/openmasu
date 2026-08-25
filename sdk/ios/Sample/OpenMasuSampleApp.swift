import Foundation
import OpenMasuAppleAds
import OpenMasuApplePostback
import OpenMasuCore

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
}
