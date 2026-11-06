import Foundation

public protocol OpenMasuTransport: Sendable {
  func enroll(installationId: String) async throws -> InstallationCredential
  func deliver(credential: InstallationCredential, events: [QueuedEvent]) async throws
  func deleteInstallation(credential: InstallationCredential, installationId: String) async throws
}

public enum DeletionStatus: Sendable { case missing, processing, completed }

/// Optional capability. Existing custom transports retain synchronous deletion semantics.
public protocol OpenMasuDeletionTransport: OpenMasuTransport {
  func beginDeletion(credential: InstallationCredential, installationId: String, receipt: String) async throws -> DeletionStatus
  func deletionStatus(receipt: String) async throws -> DeletionStatus
}

/// Optional explicit opt-in. The token belongs only to the signed batch envelope.
public protocol OpenMasuSyntheticValidationTransport: OpenMasuTransport {
  func deliverForSyntheticValidation(credential: InstallationCredential, events: [QueuedEvent], sessionToken: String) async throws
}

public enum OpenMasuPrivacyRequestType: String, Sendable { case access, portability }
public enum OpenMasuPrivacyResultStatus: String, Sendable {
  case pageReady = "page_ready", complete, resetPending = "reset_pending", contextChanged = "context_changed"
  case notEnrolled = "not_enrolled", unsupported, invalidRequest = "invalid_request", requestFailed = "request_failed"
}

/// Optional capability; existing custom transports need no changes.
public protocol OpenMasuPrivacyTransport: OpenMasuTransport {
  func privacyPage(credential: InstallationCredential, installationId: String, requestType: OpenMasuPrivacyRequestType,
    cursor: String?, pageSize: Int) async throws -> Data
}

public struct OpenMasuPrivacyPage: Sendable, CustomStringConvertible {
  public let payloadJSON: Data
  public let requestId: String
  public let cutoffAt: String
  public let nextCursor: String?
  public let complete: Bool
  public let returnedCount: Int
  public var description: String { "OpenMasuPrivacyPage(redacted)" }
  static let maxBytes = 262144
  static func validRequest(cursor: String?, pageSize: Int) -> Bool {
    (1...500).contains(pageSize) && (cursor == nil || cursor!.range(of: "^[A-Za-z0-9_-]{1,16384}$", options: .regularExpression) != nil)
  }
  static func parse(_ data: Data, requestType: OpenMasuPrivacyRequestType, pageSize: Int) throws -> Self {
    guard data.count <= maxBytes, let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      value["dsar_response_version"] as? String == "internal-v2", value["request_type"] as? String == requestType.rawValue,
      let complete = value["complete"] as? Bool, value["next_cursor"] != nil,
      let records = value["records"] as? [[String: Any]], let attributions = value["attributions"] as? [[String: Any]],
      let commerce = value["verified_commerce_lifecycle"] as? [[String: Any]],
      let id = value["request_id"] as? String, !id.isEmpty, id.count <= 128,
      let cutoff = value["cutoff_at"] as? String, (20...40).contains(cutoff.count)
    else { throw OpenMasuError.responseInvalid }
    let cursor = value["next_cursor"] as? String
    let count = records.count + attributions.count + commerce.count
    guard (value["next_cursor"] is NSNull || cursor != nil), complete == (cursor == nil),
      validRequest(cursor: cursor, pageSize: pageSize), count <= pageSize,
      value["returned_count"] as? Int == count, value["page_size"] as? Int == pageSize
    else { throw OpenMasuError.responseInvalid }
    return Self(payloadJSON: data, requestId: id, cutoffAt: cutoff, nextCursor: cursor, complete: complete, returnedCount: count)
  }
}

public struct OpenMasuPrivacyResult: Sendable, CustomStringConvertible {
  public let status: OpenMasuPrivacyResultStatus
  public let page: OpenMasuPrivacyPage?
  public var description: String { "OpenMasuPrivacyResult(\(status.rawValue))" }
  init(_ status: OpenMasuPrivacyResultStatus, page: OpenMasuPrivacyPage? = nil) { self.status = status; self.page = page }
  /// Native bridge framing only; never log or enqueue this sensitive value.
  public var bridgeValue: String { status.rawValue + "\n" + (page.flatMap { String(data: $0.payloadJSON, encoding: .utf8) } ?? "") }
}

public final class HmacHttpTransport: OpenMasuAppStoreTransport, OpenMasuDeletionTransport, OpenMasuSyntheticValidationTransport, OpenMasuPrivacyTransport, @unchecked Sendable {
  private let configuration: OpenMasuConfiguration
  private let session: URLSession

  public init(configuration: OpenMasuConfiguration, session: URLSession = .shared) {
    self.configuration = configuration
    self.session = session
  }

  public func privacyPage(credential: InstallationCredential, installationId: String, requestType: OpenMasuPrivacyRequestType,
    cursor: String?, pageSize: Int) async throws -> Data {
    guard OpenMasuPrivacyPage.validRequest(cursor: cursor, pageSize: pageSize) else { throw OpenMasuError.responseInvalid }
    var value: [String: Any] = ["installation_id": installationId, "request_type": requestType.rawValue,
      "pagination": "cursor_v1", "page_size": pageSize]
    if let cursor { value["cursor"] = cursor }
    let body = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
    let response = try await request(path: "/v1/privacy/access", body: body, credential: credential, maxBytes: OpenMasuPrivacyPage.maxBytes)
    guard response.status == 200 else { throw OpenMasuError.transport(response.status) }
    return response.body
  }

  public func enroll(installationId: String) async throws -> InstallationCredential {
    let body = try EventFactory.json(["installation_id": installationId]).data(using: .utf8)!
    let response = try await request(path: "/v1/installations", body: body, credential: nil)
    guard response.status == 201,
          let value = try JSONSerialization.jsonObject(with: response.body) as? [String: Any],
          let keyId = value["installation_key_id"] as? String,
          let secret = value["installation_secret"] as? String
    else { throw OpenMasuError.transport(response.status) }
    return InstallationCredential(keyId: keyId, secret: secret)
  }

  public func deliver(credential: InstallationCredential, events: [QueuedEvent]) async throws {
    let body = try EventFactory.envelope(
      events: events,
      producerVersion: configuration.sdkVersion,
      wrapperVersion: configuration.wrapperVersion
    )
    let response = try await request(path: "/v1/events/batch", body: body, credential: credential)
    guard response.status == 202 else { throw OpenMasuError.transport(response.status) }
  }

  public func deleteInstallation(credential: InstallationCredential, installationId: String) async throws {
    let body = try EventFactory.json(["installation_id": installationId]).data(using: .utf8)!
    let response = try await request(path: "/v1/privacy/installation", body: body, credential: credential)
    guard response.status == 201 else { throw OpenMasuError.transport(response.status) }
  }

  public func deliverForSyntheticValidation(credential: InstallationCredential, events: [QueuedEvent], sessionToken: String) async throws {
    guard SyntheticValidationSession.validToken(sessionToken) else { throw OpenMasuSyntheticValidationError.invalidSession }
    let original = try EventFactory.envelope(events: events, producerVersion: configuration.sdkVersion, wrapperVersion: configuration.wrapperVersion)
    guard var envelope = try JSONSerialization.jsonObject(with: original) as? [String: Any] else { throw OpenMasuError.responseInvalid }
    envelope["validation_session_token"] = sessionToken
    let body = try JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys, .withoutEscapingSlashes])
    let response = try await request(path: "/v1/events/batch", body: body, credential: credential)
    guard response.status == 202 else { throw OpenMasuError.transport(response.status) }
  }

  public func beginDeletion(credential: InstallationCredential, installationId: String, receipt: String) async throws -> DeletionStatus {
    let body = try EventFactory.json(["installation_id": installationId, "status_receipt": receipt]).data(using: .utf8)!
    let response = try await request(path: "/v1/privacy/installation", body: body, credential: credential)
    guard response.status == 201 || response.status == 202 else { throw OpenMasuError.transport(response.status) }
    return try decodeDeletionStatus(response.body)
  }

  public func deletionStatus(receipt: String) async throws -> DeletionStatus {
    let body = try EventFactory.json(["status_receipt": receipt]).data(using: .utf8)!
    let response = try await request(path: "/v1/privacy/installation/status", body: body, credential: nil, authenticated: false)
    if response.status == 404 { return .missing }
    guard response.status == 200 else { throw OpenMasuError.transport(response.status) }
    return try decodeDeletionStatus(response.body)
  }

  private func decodeDeletionStatus(_ body: Data) throws -> DeletionStatus {
    let value = try JSONSerialization.jsonObject(with: body) as? [String: Any]
    switch value?["status"] as? String {
    case "completed": return .completed
    case "processing": return .processing
    default: throw OpenMasuError.responseInvalid
    }
  }

  func request(
    path: String,
    body: Data,
    credential: InstallationCredential?,
    authenticated: Bool = true,
    maxBytes: Int? = nil
  ) async throws -> (status: Int, body: Data) {
    let timestampMs = Int64(Date().timeIntervalSince1970 * 1_000)
    let nonceBytes = Data((0..<18).map { _ in UInt8.random(in: 0...255) })
    let nonce = nonceBytes.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
    let canonical = SdkRequestSigner.canonical(
      method: "POST",
      path: path,
      sdkKeyId: configuration.sdkKeyId,
      installationKeyId: credential?.keyId,
      timestampMs: timestampMs,
      nonce: nonce,
      body: body
    )
    let signature = SdkRequestSigner.sign(secret: credential?.secret ?? configuration.sdkSecret, canonical: canonical)
    guard let url = URL(string: path, relativeTo: configuration.endpoint) else { throw OpenMasuError.responseInvalid }
    var request = URLRequest(url: url, timeoutInterval: configuration.requestTimeout)
    request.httpMethod = "POST"
    request.httpBody = body
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    if authenticated {
      request.setValue(configuration.sdkKeyId, forHTTPHeaderField: "x-openmasu-sdk-key-id")
      if let credential { request.setValue(credential.keyId, forHTTPHeaderField: "x-openmasu-installation-key-id") }
      request.setValue(String(timestampMs), forHTTPHeaderField: "x-openmasu-timestamp-ms")
      request.setValue(nonce, forHTTPHeaderField: "x-openmasu-nonce")
      request.setValue(signature, forHTTPHeaderField: "x-openmasu-signature")
    }
    if let maxBytes {
      let (bytes, rawResponse) = try await session.bytes(for: request)
      guard let response = rawResponse as? HTTPURLResponse else { throw OpenMasuError.responseInvalid }
      var data = Data()
      for try await byte in bytes {
        guard data.count < maxBytes else { throw OpenMasuError.responseInvalid }
        data.append(byte)
      }
      return (response.statusCode, data)
    }
    let (data, rawResponse) = try await session.data(for: request)
    guard let response = rawResponse as? HTTPURLResponse else { throw OpenMasuError.responseInvalid }
    return (response.statusCode, data)
  }
}
