import Foundation

public protocol OpenMmpTransport: Sendable {
  func enroll(installationId: String) async throws -> InstallationCredential
  func deliver(credential: InstallationCredential, events: [QueuedEvent]) async throws
  func deleteInstallation(credential: InstallationCredential, installationId: String) async throws
}

public final class HmacHttpTransport: OpenMmpTransport, @unchecked Sendable {
  private let configuration: OpenMmpConfiguration
  private let session: URLSession

  public init(configuration: OpenMmpConfiguration, session: URLSession = .shared) {
    self.configuration = configuration
    self.session = session
  }

  public func enroll(installationId: String) async throws -> InstallationCredential {
    let body = try EventFactory.json(["installation_id": installationId]).data(using: .utf8)!
    let response = try await request(path: "/v1/installations", body: body, credential: nil)
    guard response.status == 201,
          let value = try JSONSerialization.jsonObject(with: response.body) as? [String: Any],
          let keyId = value["installation_key_id"] as? String,
          let secret = value["installation_secret"] as? String
    else { throw OpenMmpError.transport(response.status) }
    return InstallationCredential(keyId: keyId, secret: secret)
  }

  public func deliver(credential: InstallationCredential, events: [QueuedEvent]) async throws {
    let body = try EventFactory.envelope(
      events: events,
      producerVersion: configuration.sdkVersion,
      wrapperVersion: configuration.wrapperVersion
    )
    let response = try await request(path: "/v1/events/batch", body: body, credential: credential)
    guard response.status == 202 else { throw OpenMmpError.transport(response.status) }
  }

  public func deleteInstallation(credential: InstallationCredential, installationId: String) async throws {
    let body = try EventFactory.json(["installation_id": installationId]).data(using: .utf8)!
    let response = try await request(path: "/v1/privacy/installation", body: body, credential: credential)
    guard response.status == 201 else { throw OpenMmpError.transport(response.status) }
  }

  private func request(
    path: String,
    body: Data,
    credential: InstallationCredential?
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
    guard let url = URL(string: path, relativeTo: configuration.endpoint) else { throw OpenMmpError.responseInvalid }
    var request = URLRequest(url: url, timeoutInterval: configuration.requestTimeout)
    request.httpMethod = "POST"
    request.httpBody = body
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.setValue(configuration.sdkKeyId, forHTTPHeaderField: "x-openmmp-sdk-key-id")
    if let credential { request.setValue(credential.keyId, forHTTPHeaderField: "x-openmmp-installation-key-id") }
    request.setValue(String(timestampMs), forHTTPHeaderField: "x-openmmp-timestamp-ms")
    request.setValue(nonce, forHTTPHeaderField: "x-openmmp-nonce")
    request.setValue(signature, forHTTPHeaderField: "x-openmmp-signature")
    let (data, rawResponse) = try await session.data(for: request)
    guard let response = rawResponse as? HTTPURLResponse else { throw OpenMmpError.responseInvalid }
    return (response.statusCode, data)
  }
}
