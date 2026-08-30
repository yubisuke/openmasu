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

public enum AppleConversionType: String, Codable, Hashable, Sendable {
  case install
  case reengagement = "re-engagement"
}

public enum AdAttributionKitReengagementURL {
  public static let conversionTagParameter = "AdAttributionKitReengagementOpen"

  public static func conversionTag(from url: URL) -> String? {
    guard let value = URLComponents(url: url, resolvingAgainstBaseURL: false)?
      .queryItems?
      .first(where: { $0.name == conversionTagParameter })?
      .value,
      !value.isEmpty
    else { return nil }
    return value
  }
}

public struct ConversionUpdate: Codable, Equatable, Sendable {
  public let fineValue: Int
  public let coarseValue: CoarseValue
  public let lockPostback: Bool
  public let conversionTypes: [AppleConversionType]?
  public let conversionTag: String?

  public init(
    fineValue: Int,
    coarseValue: CoarseValue,
    lockPostback: Bool,
    conversionTypes: [AppleConversionType]? = nil,
    conversionTag: String? = nil
  ) throws {
    guard (0...63).contains(fineValue) else { throw OpenMasuError.conversionSchema("fine_value_out_of_range") }
    if let conversionTypes {
      guard !conversionTypes.isEmpty, Set(conversionTypes).count == conversionTypes.count else {
        throw OpenMasuError.conversionSchema("conversion_types_invalid")
      }
    }
    if let conversionTag, conversionTag.isEmpty {
      throw OpenMasuError.conversionSchema("conversion_tag_empty")
    }
    if conversionTag != nil, conversionTypes != [.reengagement] {
      throw OpenMasuError.conversionSchema("conversion_tag_requires_reengagement")
    }
    self.fineValue = fineValue
    self.coarseValue = coarseValue
    self.lockPostback = lockPostback
    self.conversionTypes = conversionTypes
    self.conversionTag = conversionTag
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
  public func record(
    eventName: String,
    conversionTypes: [AppleConversionType]? = nil,
    conversionTag: String? = nil
  ) async throws -> ConversionUpdate {
    let nextSignals = signals + [ConversionSignal(eventName: eventName)]
    let evaluated = try schema.evaluate(signals: nextSignals)
    let value = try ConversionUpdate(
      fineValue: evaluated.fineValue,
      coarseValue: evaluated.coarseValue,
      lockPostback: evaluated.lockPostback,
      conversionTypes: conversionTypes,
      conversionTag: conversionTag
    )
    try await updater.update(value)
    signals = nextSignals
    if loggingEnabled, let sink {
      try await sink.recordConversionUpdate(schemaVersion: schema.schemaVersion, value: value)
    }
    return value
  }
}

public struct SystemAppleConversionUpdater: AppleConversionUpdating {
  public init() {}

  public func update(_ value: ConversionUpdate) async throws {
    #if os(iOS)
    #if canImport(AdAttributionKit)
    if value.conversionTag != nil {
      guard #available(iOS 18.4, *) else {
        throw OpenMasuError.conversionSchema("conversion_tag_unsupported")
      }
    }
    if value.conversionTypes != nil {
      guard #available(iOS 18.0, *) else {
        throw OpenMasuError.conversionSchema("conversion_types_unsupported")
      }
    }
    #else
    if value.conversionTag != nil || value.conversionTypes != nil {
      throw OpenMasuError.conversionSchema("conversion_targeting_unsupported")
    }
    #endif
    #endif
    var firstFailure: Error?
    let updatesInstallPostbacks = value.conversionTag == nil
      && (value.conversionTypes == nil || value.conversionTypes?.contains(.install) == true)
    #if canImport(StoreKit) && os(iOS)
    if #available(iOS 16.1, *), updatesInstallPostbacks {
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
        if #available(iOS 18.4, *), let conversionTag = value.conversionTag {
          let update = AdAttributionKit.PostbackUpdate(
            fineConversionValue: value.fineValue,
            lockPostback: value.lockPostback,
            conversionTag: conversionTag,
            coarseConversionValue: coarse,
            conversionTypes: value.conversionTypes?.map(Self.systemConversionType)
          )
          try await AdAttributionKit.Postback.updateConversionValue(update)
        } else if #available(iOS 18.0, *), let conversionTypes = value.conversionTypes {
          let update = AdAttributionKit.PostbackUpdate(
            fineConversionValue: value.fineValue,
            lockPostback: value.lockPostback,
            coarseConversionValue: coarse,
            conversionTypes: conversionTypes.map(Self.systemConversionType)
          )
          try await AdAttributionKit.Postback.updateConversionValue(update)
        } else {
          try await AdAttributionKit.Postback.updateConversionValue(
            value.fineValue,
            coarseConversionValue: coarse,
            lockPostback: value.lockPostback
          )
        }
      } catch { if firstFailure == nil { firstFailure = error } }
    }
    #endif
    if let firstFailure { throw firstFailure }
  }

  #if canImport(AdAttributionKit) && os(iOS)
  @available(iOS 18.0, *)
  private static func systemConversionType(
    _ value: AppleConversionType
  ) -> AdAttributionKit.PostbackUpdate.ConversionType {
    switch value {
    case .install: return .install
    case .reengagement: return .reengagement
    }
  }
  #endif
}
