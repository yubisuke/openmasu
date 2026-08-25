import Foundation

public struct OpenMmpConfiguration: Sendable {
  public let endpoint: URL
  public let sdkKeyId: String
  public let sdkSecret: String
  public let sdkVersion: String
  public let wrapperVersion: String?
  public let requestTimeout: TimeInterval
  public let collectionEnabledByDefault: Bool
  public let conversionSchemaVersion: String?
  public let conversionSchemaSha256: String?

  public init(
    endpoint: URL,
    sdkKeyId: String,
    sdkSecret: String,
    sdkVersion: String = "0.1.0",
    wrapperVersion: String? = nil,
    requestTimeout: TimeInterval = 10,
    collectionEnabledByDefault: Bool = true,
    conversionSchemaVersion: String? = nil,
    conversionSchemaSha256: String? = nil
  ) {
    precondition(endpoint.scheme == "https" || endpoint.host == "127.0.0.1" || endpoint.host == "localhost")
    precondition((conversionSchemaVersion == nil) == (conversionSchemaSha256 == nil))
    if let conversionSchemaVersion { precondition(!conversionSchemaVersion.isEmpty) }
    if let conversionSchemaSha256 {
      precondition(conversionSchemaSha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil)
    }
    self.endpoint = endpoint
    self.sdkKeyId = sdkKeyId
    self.sdkSecret = sdkSecret
    self.sdkVersion = sdkVersion
    self.wrapperVersion = wrapperVersion
    self.requestTimeout = requestTimeout
    self.collectionEnabledByDefault = collectionEnabledByDefault
    self.conversionSchemaVersion = conversionSchemaVersion
    self.conversionSchemaSha256 = conversionSchemaSha256
  }
}

public struct InstallationCredential: Codable, Equatable, Sendable {
  public let keyId: String
  public let secret: String

  public init(keyId: String, secret: String) {
    self.keyId = keyId
    self.secret = secret
  }
}

public struct QueuedEvent: Equatable, Sendable {
  public let eventId: String
  public let eventName: String
  public let processingPurposeId: String
  public let payloadJson: String
  public let occurredAt: String
  public let processingSequence: Int64
  public let enqueuedAtMs: Int64

  public init(
    eventId: String,
    eventName: String,
    processingPurposeId: String,
    payloadJson: String,
    occurredAt: String,
    processingSequence: Int64,
    enqueuedAtMs: Int64
  ) {
    self.eventId = eventId
    self.eventName = eventName
    self.processingPurposeId = processingPurposeId
    self.payloadJson = payloadJson
    self.occurredAt = occurredAt
    self.processingSequence = processingSequence
    self.enqueuedAtMs = enqueuedAtMs
  }
}

public enum OpenMmpError: Error, Equatable {
  case collectionDisabled
  case invalidEventKey
  case invalidAttributes
  case invalidMoney
  case transport(Int)
  case responseInvalid
  case resetRequiresEnrollment
  case storage(String)
  case conversionSchema(String)
}

enum EventFactory {
  private static let canonicalFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()

  static func canonicalNow(_ date: Date = Date()) -> String {
    canonicalFormatter.string(from: date)
  }

  static func identifier(_ prefix: String) -> String { "\(prefix):\(UUID().uuidString.lowercased())" }

  static func json(_ object: [String: Any]) throws -> String {
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
    guard let value = String(data: data, encoding: .utf8) else { throw OpenMmpError.responseInvalid }
    return value
  }

  static func install(
    installationId: String,
    sdkVersion: String,
    origin: String,
    adServicesToken: String?,
    conversionSchemaVersion: String?,
    conversionSchemaSha256: String?
  ) throws -> String {
    var extensions: [String: Any] = [:]
    if let adServicesToken { extensions["adservices_attribution_token_protected"] = adServicesToken }
    if let conversionSchemaVersion { extensions["conversion_schema_version"] = conversionSchemaVersion }
    if let conversionSchemaSha256 { extensions["conversion_schema_sha256"] = conversionSchemaSha256 }
    var payload: [String: Any] = [
      "event_name": "install",
      "installation_id": installationId,
      "install_type": "first_install",
      "install_origin": origin,
      "referrer_status": "not_applicable",
      "sdk_version": sdkVersion,
      "extensions": extensions,
    ]
    return try json(payload)
  }

  static func envelope(
    events: [QueuedEvent],
    producerVersion: String,
    wrapperVersion: String?
  ) throws -> Data {
    let records: [[String: Any]] = try events.map { event in
      guard let payloadData = event.payloadJson.data(using: .utf8),
            let payload = try JSONSerialization.jsonObject(with: payloadData) as? [String: Any]
      else { throw OpenMmpError.responseInvalid }
      var record: [String: Any] = [
        "event_id": event.eventId,
        "event_name": event.eventName,
        "occurred_at": event.occurredAt,
        "occurred_at_source": "device",
        "processing_purpose_id": event.processingPurposeId,
        "processing_sequence": event.processingSequence,
        "producer_version": producerVersion,
        "payload": payload,
      ]
      if let wrapperVersion { record["wrapper_version"] = wrapperVersion }
      return record
    }
    return try JSONSerialization.data(withJSONObject: ["records": records], options: [.sortedKeys, .withoutEscapingSlashes])
  }
}
