import CryptoKit
import Foundation
#if canImport(OpenMasuCore)
import OpenMasuCore
#endif
#if canImport(StoreKit)
import StoreKit
#endif
#if canImport(AdAttributionKit)
import AdAttributionKit
#endif

public enum CoarseValue: String, Codable, Sendable { case low, medium, high }

public struct ConversionUpdate: Codable, Equatable, Sendable {
  public let fineValue: Int
  public let coarseValue: CoarseValue
  public let lockPostback: Bool

  public init(fineValue: Int, coarseValue: CoarseValue, lockPostback: Bool) throws {
    guard (0...63).contains(fineValue) else { throw OpenMasuError.conversionSchema("fine_value_out_of_range") }
    self.fineValue = fineValue
    self.coarseValue = coarseValue
    self.lockPostback = lockPostback
  }
}

public struct ConversionSignal: Codable, Equatable, Sendable {
  public let eventName: String
  public init(eventName: String) { self.eventName = eventName }
}

public struct ConversionSchema: Equatable, Sendable {
  public struct Rule: Codable, Equatable, Sendable {
    public let minimumEventCount: Int
    public let fineValue: Int
    public let coarseValue: CoarseValue
    public let lockPostback: Bool

    enum CodingKeys: String, CodingKey {
      case minimumEventCount = "minimum_event_count"
      case fineValue = "fine_value"
      case coarseValue = "coarse_value"
      case lockPostback = "lock_postback"
    }
  }

  private struct WireSchema: Codable {
    let schemaVersion: String
    let rules: [Rule]
    enum CodingKeys: String, CodingKey { case schemaVersion = "schema_version"; case rules }
  }

  public let schemaVersion: String
  public let rules: [Rule]
  public let sha256: String

  public init(data: Data) throws {
    let decoded = try JSONDecoder().decode(WireSchema.self, from: data)
    guard !decoded.schemaVersion.isEmpty, !decoded.rules.isEmpty else {
      throw OpenMasuError.conversionSchema("conversion_schema_empty")
    }
    for rule in decoded.rules {
      guard rule.minimumEventCount >= 0, (0...63).contains(rule.fineValue) else {
        throw OpenMasuError.conversionSchema("conversion_schema_value_invalid")
      }
    }
    schemaVersion = decoded.schemaVersion
    rules = decoded.rules
    sha256 = Self.digest(data: data)
  }

  public func evaluate(eventCount: Int) throws -> ConversionUpdate {
    try evaluate(signals: (0..<eventCount).map { _ in ConversionSignal(eventName: "synthetic_event") })
  }

  public func evaluate(signals: [ConversionSignal]) throws -> ConversionUpdate {
    guard let rule = rules
      .filter({ $0.minimumEventCount <= signals.count })
      .sorted(by: { $0.minimumEventCount > $1.minimumEventCount })
      .first
    else { throw OpenMasuError.conversionSchema("conversion_schema_no_match") }
    return try ConversionUpdate(
      fineValue: rule.fineValue,
      coarseValue: rule.coarseValue,
      lockPostback: rule.lockPostback
    )
  }

  public static func digest(data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
}

public struct ConversionSchemaRegistry: Sendable {
  private let registeredDigests: [String: String]

  public init(registeredDigests: [String: String]) { self.registeredDigests = registeredDigests }

  public func load(data: Data) throws -> ConversionSchema {
    let schema = try ConversionSchema(data: data)
    guard let digest = registeredDigests[schema.schemaVersion] else {
      throw OpenMasuError.conversionSchema("conversion_schema_version_unregistered")
    }
    guard digest == schema.sha256 else {
      throw OpenMasuError.conversionSchema("conversion_schema_digest_mismatch")
    }
    return schema
  }
}

public enum OpenMasuConversionResources {
  public static var defaultSchemaURL: URL? {
    #if SWIFT_PACKAGE
    Bundle.module.url(forResource: "conversion-schema-v1", withExtension: "json")
    #else
    Bundle.main.url(forResource: "conversion-schema-v1", withExtension: "json")
    #endif
  }
}

public protocol AppleConversionUpdating: Sendable {
  func update(_ value: ConversionUpdate) async throws
}

public protocol ConversionEventSink: Sendable {
  func recordConversionUpdate(schemaVersion: String, value: ConversionUpdate) async throws
}

public struct SdkConversionEventSink: ConversionEventSink {
  private let sdk: OpenMasuSDK
  public init(sdk: OpenMasuSDK) { self.sdk = sdk }
  public func recordConversionUpdate(schemaVersion: String, value: ConversionUpdate) async throws {
    try await sdk.recordConversionValueUpdate(
      schemaVersion: schemaVersion,
      fineValue: value.fineValue,
      coarseValue: value.coarseValue.rawValue,
      lockPostback: value.lockPostback
    )
  }
}

public actor ConversionValueController {
  private let schema: ConversionSchema
  private let updater: any AppleConversionUpdating
  private let sink: (any ConversionEventSink)?
  private let loggingEnabled: Bool
  private var signals: [ConversionSignal] = []

  public init(
    schema: ConversionSchema,
    updater: any AppleConversionUpdating,
    sink: (any ConversionEventSink)? = nil,
    loggingEnabled: Bool = false
  ) {
    self.schema = schema
    self.updater = updater
    self.sink = sink
    self.loggingEnabled = loggingEnabled
  }

  @discardableResult
  public func record(eventName: String) async throws -> ConversionUpdate {
    signals.append(ConversionSignal(eventName: eventName))
    let value = try schema.evaluate(signals: signals)
    try await updater.update(value)
    if loggingEnabled, let sink {
      try await sink.recordConversionUpdate(schemaVersion: schema.schemaVersion, value: value)
    }
    return value
  }
}

public struct SystemAppleConversionUpdater: AppleConversionUpdating {
  public init() {}

  public func update(_ value: ConversionUpdate) async throws {
    var firstFailure: Error?
    #if canImport(StoreKit) && os(iOS)
    if #available(iOS 16.1, *) {
      do {
        let coarse: SKAdNetwork.CoarseConversionValue
        switch value.coarseValue {
        case .low: coarse = .low
        case .medium: coarse = .medium
        case .high: coarse = .high
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
          SKAdNetwork.updatePostbackConversionValue(
            value.fineValue,
            coarseValue: coarse,
            lockWindow: value.lockPostback
          ) { error in
            if let error { continuation.resume(throwing: error) }
            else { continuation.resume() }
          }
        }
      } catch { firstFailure = error }
    }
    #endif

    #if canImport(AdAttributionKit) && os(iOS)
    if #available(iOS 17.4, *) {
      do {
        let coarse: AdAttributionKit.CoarseConversionValue
        switch value.coarseValue {
        case .low: coarse = .low
        case .medium: coarse = .medium
        case .high: coarse = .high
        }
        try await AdAttributionKit.Postback.updateConversionValue(
          value.fineValue,
          coarseConversionValue: coarse,
          lockPostback: value.lockPostback
        )
      } catch { if firstFailure == nil { firstFailure = error } }
    }
    #endif
    if let firstFailure { throw firstFailure }
  }
}
