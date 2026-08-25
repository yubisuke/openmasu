import Foundation

public struct OpenMasuConfiguration: Sendable {
  public let endpoint: URL
  public let sdkKeyId: String
  public let sdkSecret: String
  public let sdkVersion: String
  public let wrapperVersion: String?
  public let requestTimeout: TimeInterval
  public let collectionEnabledByDefault: Bool
  public let conversionSchemaVersion: String?
  public let conversionSchemaSha256: String?
  public let deepLinkHosts: Set<String>
  public let deepLinkSchemes: Set<String>

  public init(
    endpoint: URL,
    sdkKeyId: String,
    sdkSecret: String,
    sdkVersion: String = "0.1.0",
    wrapperVersion: String? = nil,
    requestTimeout: TimeInterval = 10,
    collectionEnabledByDefault: Bool = true,
    conversionSchemaVersion: String? = nil,
    conversionSchemaSha256: String? = nil,
    deepLinkHosts: Set<String> = [],
    deepLinkSchemes: Set<String> = []
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
    self.deepLinkHosts = Set(deepLinkHosts.map { $0.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")) })
    self.deepLinkSchemes = Set(deepLinkSchemes.map { $0.lowercased() })
  }
}

public struct OpenMasuDeepLink: Equatable, Sendable {
  public let value: String?
  public let parameters: [String: String]
  public let openSource: String
  public let destinationStatus: String
  public let linkSlug: String
}

enum DeepLinkParser {
  static func direct(_ url: URL, allowedHosts: Set<String>, allowedSchemes: Set<String> = []) -> OpenMasuDeepLink? {
    let scheme = url.scheme?.lowercased() ?? ""
    let isWeb = ["http", "https"].contains(scheme)
    guard (isWeb || allowedSchemes.contains(scheme)),
          let host = url.host?.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")),
          allowedHosts.contains(host)
    else { return nil }
    let parts = url.path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
    guard parts.count >= 2, parts[0] == "r",
          parts[1].range(of: "^[A-Za-z0-9_-]{12,64}$", options: .regularExpression) != nil
    else { return nil }
    let destination = Array(parts.dropFirst(2))
    let destinationValid = destination.count <= 8 && destination.allSatisfy({
      $0 != "." && $0 != ".." && $0.range(of: "^[A-Za-z0-9._~-]{1,64}$", options: .regularExpression) != nil
    })
    var parameters: [String: String] = [:]
    for item in (URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).sorted(by: { $0.name < $1.name }) {
      guard parameters.count < 10,
            let match = item.name.range(of: "^dlp_[a-z][a-z0-9_]{0,63}$", options: .regularExpression),
            match == item.name.startIndex..<item.name.endIndex,
            let value = item.value, value.range(of: "^[A-Za-z0-9._~-]{1,64}$", options: .regularExpression) != nil
      else { continue }
      parameters[String(item.name.dropFirst(4))] = value
    }
    return OpenMasuDeepLink(
      value: destinationValid && !destination.isEmpty ? "/" + destination.joined(separator: "/") : nil,
      parameters: parameters,
      openSource: isWeb ? "ios_universal_link" : "custom_scheme",
      destinationStatus: !destinationValid ? "rejected" : (destination.isEmpty ? "absent" : "delivered"),
      linkSlug: parts[1]
    )
  }
}

final class DeepLinkRouter: @unchecked Sendable {
  private let lock = NSLock()
  private var listener: (@Sendable (OpenMasuDeepLink) -> Void)?
  func set(_ value: (@Sendable (OpenMasuDeepLink) -> Void)?) { lock.lock(); listener = value; lock.unlock() }
  func deliver(_ value: OpenMasuDeepLink) { lock.lock(); let target = listener; lock.unlock(); target?(value) }
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

public enum OpenMasuError: Error, Equatable {
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

  static func commerceEventIdentifier(
    eventName: String,
    installationId: String,
    transactionId: String,
    originalTransactionId: String?,
    amountUnscaled: String,
    amountScale: Int,
    currency: String,
    correctionTargetRecordId: String? = nil
  ) -> String {
    var fields = [
      "openmasu-commerce-event-v2",
      eventName,
      installationId,
      transactionId,
      originalTransactionId ?? "",
      amountUnscaled,
      String(amountScale),
      currency,
      "settled",
    ]
    if let correctionTargetRecordId { fields.append(correctionTargetRecordId) }
    let canonical = fields.joined(separator: "\n")
    return "event:commerce:\(SdkRequestSigner.sha256(Data(canonical.utf8)))"
  }

  static func json(_ object: [String: Any]) throws -> String {
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
    guard let value = String(data: data, encoding: .utf8) else { throw OpenMasuError.responseInvalid }
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
      else { throw OpenMasuError.responseInvalid }
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

  static func deepLink(installationId: String, value: OpenMasuDeepLink) throws -> String {
    var payload: [String: Any] = [
      "event_name": "deep_link_open",
      "installation_id": installationId,
      "open_source": value.openSource,
      "link_slug": value.linkSlug,
      "destination_status": value.destinationStatus,
      "deep_link_params": value.parameters,
    ]
    if let destination = value.value { payload["deep_link_value"] = destination }
    return try json(payload)
  }
}
