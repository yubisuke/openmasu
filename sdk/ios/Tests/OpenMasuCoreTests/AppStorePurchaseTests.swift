import Foundation
import XCTest
@testable import OpenMasuCore

final class AppStorePurchaseTests: XCTestCase {
  private let product = "synthetic.monthly"
  private let compact = "syntheticHeader.syntheticPayload.syntheticSignature"
  private let intent = UUID(uuidString: "db636db3-5cdc-4c01-b651-960afc2a7372")!
  private let token = UUID(uuidString: "de78c851-3221-4f1c-b27f-2501e66aefb4")!

  func testRawBodyHmacPreparationRetryAndPendingSubmissionDoNotQueueMoney() async throws {
    let recorder = PurchaseRequestRecorder()
    let requestId = UUID()
    let preparedBody = try response()
    let pending = try json(["intent_id": intent.uuidString, "state": "pending"])
    let (sdk, storage) = try httpSdk { request in
      let body = try requestBody(request)
      recorder.append(request, body)
      let path = request.url!.path
      let credential = InstallationCredential(keyId: "installation-key:synthetic", secret: "synthetic-installation-secret-32-bytes")
      let canonical = SdkRequestSigner.canonical(
        method: "POST", path: path, sdkKeyId: "sdk-key:synthetic", installationKeyId: credential.keyId,
        timestampMs: Int64(request.value(forHTTPHeaderField: "x-openmasu-timestamp-ms")!)!,
        nonce: request.value(forHTTPHeaderField: "x-openmasu-nonce")!, body: body
      )
      XCTAssertEqual(request.value(forHTTPHeaderField: "x-openmasu-signature"), SdkRequestSigner.sign(secret: credential.secret, canonical: canonical))
      XCTAssertEqual(request.value(forHTTPHeaderField: "x-openmasu-installation-key-id"), credential.keyId)
      XCTAssertNil(request.url?.query)
      XCTAssertNil(request.value(forHTTPHeaderField: "authorization"))
      return path.hasSuffix("/prepare") ? (200, preparedBody) : (202, pending)
    }
    let first = try await sdk.prepareAppStorePurchase(productId: product, requestId: requestId, revenueMeasurementConsent: true)
    let retried = try await sdk.prepareAppStorePurchase(productId: product, requestId: requestId, revenueMeasurementConsent: true)
    XCTAssertEqual(first, retried)
    XCTAssertEqual(first.appAccountToken, token)
    XCTAssertEqual(first.environment, .sandbox)
    let reopened = try JSONDecoder().decode(OpenMasuPreparedAppStorePurchase.self, from: JSONEncoder().encode(first))
    let admitted = try await sdk.submitAppStorePurchase(prepared: reopened, signedTransaction: compact, revenueMeasurementConsent: true)
    XCTAssertEqual(admitted.intentId, intent)
    XCTAssertEqual(admitted.state, .pending)
    let requests = recorder.values()
    XCTAssertEqual(requests.map { $0.0.url!.path }, ["/v1/apple/purchases/prepare", "/v1/apple/purchases/prepare", "/v1/apple/purchases/submit"])
    XCTAssertEqual(requests[0].1, requests[1].1, "only the HMAC nonce/timestamp changes on a preparation retry")
    let prepare = try JSONSerialization.jsonObject(with: requests[0].1) as! [String: Any]
    XCTAssertEqual(Set(prepare.keys), Set(["request_id", "installation_id", "product_id", "revenue_measurement_consent"]))
    XCTAssertEqual(prepare["request_id"] as? String, requestId.uuidString.lowercased())
    let submit = try JSONSerialization.jsonObject(with: requests[2].1) as! [String: Any]
    XCTAssertEqual(Set(submit.keys), Set(["intent_id", "installation_id", "signed_transaction", "revenue_measurement_consent"]))
    XCTAssertEqual(submit["signed_transaction"] as? String, compact)
    XCTAssertEqual(try storage.count(), 0)
    for file in try storage.writtenFiles() {
      XCTAssertNil(try Data(contentsOf: file).range(of: Data(compact.utf8)), "signed purchase evidence must not enter SDK storage")
    }
  }

  func testClosedPreparationResponseRejectsMissingTokenWrongScopeAndInventedState() async throws {
    let good = try JSONSerialization.jsonObject(with: response()) as! [String: Any]
    let changes: [[String: Any]] = [
      ["app_account_token": NSNull()], ["intent_id": "not-a-uuid"], ["product_id": "other.product"],
      ["environment": "Unverified"], ["state": "settled"], ["amount_unscaled": "1000"],
    ]
    for change in changes {
      let body = try json(good.merging(change, uniquingKeysWith: { _, new in new }))
      let (sdk, _) = try httpSdk { _ in (200, body) }
      await assertError(.responseInvalid) {
        _ = try await sdk.prepareAppStorePurchase(productId: self.product, requestId: UUID(), revenueMeasurementConsent: true)
      }
    }
  }

  func testSubmissionRequiresMatchingPendingResponseAndKeepsHttpFailureExplicit() async throws {
    for (status, body, expected) in [
      (202, try json(["intent_id": intent.uuidString, "state": "settled"]), OpenMasuError.responseInvalid),
      (202, try json(["intent_id": UUID().uuidString, "state": "pending"]), .responseInvalid),
      (202, try json(["intent_id": intent.uuidString, "state": "pending", "amount": "10"]), .responseInvalid),
      (202, Data("not-json".utf8), .responseInvalid),
      (401, Data("private response not exposed".utf8), .transport(401)),
      (403, Data(), .transport(403)), (409, Data(), .transport(409)), (503, Data(), .transport(503)),
    ] {
      let (sdk, storage) = try httpSdk { _ in (status, body) }
      let prepared = try preparation(storage)
      await assertError(expected) {
        _ = try await sdk.submitAppStorePurchase(prepared: prepared, signedTransaction: self.compact, revenueMeasurementConsent: true)
      }
      XCTAssertEqual(try storage.count(), 0)
    }
  }

  func testPreparationFailureDoesNotInventTokenAndHostCanRetrySameRequest() async throws {
    let recorder = PurchaseRequestRecorder()
    let body = try response()
    let (sdk, storage) = try httpSdk { request in
      recorder.append(request, try requestBody(request))
      return recorder.values().count == 1 ? (503, Data()) : (200, body)
    }
    let id = UUID()
    await assertError(.transport(503)) {
      _ = try await sdk.prepareAppStorePurchase(productId: self.product, requestId: id, revenueMeasurementConsent: true)
    }
    let recovered = try await sdk.prepareAppStorePurchase(productId: product, requestId: id, revenueMeasurementConsent: true)
    XCTAssertEqual(recovered.requestId, id)
    XCTAssertEqual(recovered.appAccountToken, token)
    XCTAssertEqual(recorder.values()[0].1, recorder.values()[1].1)
    XCTAssertEqual(try storage.count(), 0)
  }

  func testInvalidInputsDisabledCollectionAndMissingEnrollmentNeverSendPurchaseTraffic() async throws {
    let recorder = PurchaseRequestRecorder()
    let (sdk, storage) = try httpSdk { request in recorder.append(request, Data()); return (500, Data()) }
    await assertError(.purchaseConsentRequired) {
      _ = try await sdk.prepareAppStorePurchase(productId: self.product, requestId: UUID(), revenueMeasurementConsent: false)
    }
    await assertError(.invalidAttributes) {
      _ = try await sdk.prepareAppStorePurchase(productId: "invalid product", requestId: UUID(), revenueMeasurementConsent: true)
    }
    let prepared = try preparation(storage)
    for invalid in ["", "not.a valid.jws", String(repeating: "a", count: 256 * 1024) + ".b.c"] {
      await assertError(.invalidAttributes) {
        _ = try await sdk.submitAppStorePurchase(prepared: prepared, signedTransaction: invalid, revenueMeasurementConsent: true)
      }
    }
    await assertError(.purchaseConsentRequired) {
      _ = try await sdk.submitAppStorePurchase(prepared: prepared, signedTransaction: self.compact, revenueMeasurementConsent: false)
    }
    try await sdk.setCollectionEnabled(false)
    await assertError(.collectionDisabled) {
      _ = try await sdk.prepareAppStorePurchase(productId: self.product, requestId: UUID(), revenueMeasurementConsent: true)
    }
    XCTAssertTrue(recorder.values().isEmpty)
    let uninitialized = try OpenMasuSDK(configuration: configuration(), storageRoot: temporaryDirectory())
    await assertError(.resetRequiresEnrollment) {
      _ = try await uninitialized.prepareAppStorePurchase(productId: self.product, requestId: UUID(), revenueMeasurementConsent: true)
    }
  }

  func testOldCustomTransportRemainsUsableButDoesNotPretendToSupportPurchaseSubmission() async throws {
    let root = temporaryDirectory(), storage = try primedStorage(root)
    let transport = EventsOnlyTransport()
    let sdk = try OpenMasuSDK(configuration: configuration(), storageRoot: root, transport: transport)
    await assertError(.purchaseTransportUnsupported) {
      _ = try await sdk.prepareAppStorePurchase(productId: self.product, requestId: UUID(), revenueMeasurementConsent: true)
    }
    let prepared = try preparation(storage)
    await assertError(.purchaseTransportUnsupported) {
      _ = try await sdk.submitAppStorePurchase(prepared: prepared, signedTransaction: self.compact, revenueMeasurementConsent: true)
    }
    try await sdk.startSession()
    let delivered = await transport.deliveries
    XCTAssertEqual(delivered, 1)
  }

  func testWithdrawnConsentSurvivesReopenAndPreparedPurchaseCannotCrossReset() async throws {
    let root = temporaryDirectory(), storage = try primedStorage(root), transport = PausablePurchaseTransport()
    let sdk = try OpenMasuSDK(configuration: configuration(), storageRoot: root, transport: transport)
    let prepared = try preparation(storage)
    try await sdk.updateConsent(state: "withdrawn", policyVersion: "synthetic-v1")
    let reopened = try OpenMasuSDK(configuration: configuration(), storageRoot: root, transport: transport)
    await assertError(.purchaseConsentRequired) {
      _ = try await reopened.submitAppStorePurchase(prepared: prepared, signedTransaction: self.compact, revenueMeasurementConsent: true)
    }
    try await reopened.updateConsent(state: "granted", policyVersion: "synthetic-v1")
    try await reopened.resetInstallationId()
    await assertError(.purchaseContextChanged) {
      _ = try await reopened.submitAppStorePurchase(prepared: prepared, signedTransaction: self.compact, revenueMeasurementConsent: true)
    }
    let current = try await reopened.prepareAppStorePurchase(productId: product, requestId: UUID(), revenueMeasurementConsent: true)
    XCTAssertNotEqual(current.installationId, prepared.installationId)
    let submits = await transport.submissions
    XCTAssertEqual(submits, 0)
  }

  func testLateResponsesCannotEscapeConsentDisablementOrInstallationReset() async throws {
    for operation in ["prepare", "submit"] {
      for change in ["consent", "collection", "reset"] {
        let root = temporaryDirectory(), storage = try primedStorage(root), transport = PausablePurchaseTransport()
        let sdk = try OpenMasuSDK(configuration: configuration(), storageRoot: root, transport: transport)
        let started = expectation(description: "\(operation)-\(change) request started")
        await transport.pause(operation, started: started)
        let prepared = try preparation(storage)
        let task = Task {
          if operation == "prepare" {
            _ = try await sdk.prepareAppStorePurchase(productId: self.product, requestId: UUID(), revenueMeasurementConsent: true)
          } else {
            _ = try await sdk.submitAppStorePurchase(prepared: prepared, signedTransaction: self.compact, revenueMeasurementConsent: true)
          }
        }
        await fulfillment(of: [started], timeout: 3)
        if change == "consent" {
          try await sdk.updateConsent(state: "withdrawn", policyVersion: "synthetic-v1")
          try await sdk.updateConsent(state: "granted", policyVersion: "synthetic-v1")
        } else if change == "collection" {
          try await sdk.setCollectionEnabled(false)
          try await sdk.setCollectionEnabled(true)
        } else { try await sdk.resetInstallationId() }
        await transport.resume()
        await assertError(.purchaseContextChanged) { try await task.value }
        XCTAssertEqual(try storage.count(), 0)
      }
    }
  }

  func testResetInFlightRefusesNewPurchasePreparation() async throws {
    let root = temporaryDirectory(), transport = PausablePurchaseTransport()
    _ = try primedStorage(root)
    let sdk = try OpenMasuSDK(configuration: configuration(), storageRoot: root, transport: transport)
    let started = expectation(description: "deletion started")
    await transport.pause("delete", started: started)
    let reset = Task { try await sdk.resetInstallationId() }
    await fulfillment(of: [started], timeout: 3)
    await assertError(.purchaseContextChanged) {
      _ = try await sdk.prepareAppStorePurchase(productId: self.product, requestId: UUID(), revenueMeasurementConsent: true)
    }
    await transport.resume()
    try await reset.value
    let preparations = await transport.preparations
    XCTAssertEqual(preparations, 0)
  }

  private func configuration(endpoint: URL = URL(string: "http://127.0.0.1:1")!) -> OpenMasuConfiguration {
    OpenMasuConfiguration(endpoint: endpoint, sdkKeyId: "sdk-key:synthetic", sdkSecret: "synthetic-sdk-secret-32-bytes")
  }
  private func temporaryDirectory() -> URL {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("openmasu-purchase-\(UUID().uuidString)")
    addTeardownBlock { try? FileManager.default.removeItem(at: root) }
    return root
  }
  private func primedStorage(_ root: URL) throws -> OpenMasuStorage {
    let storage = try OpenMasuStorage(root: root)
    _ = try storage.installationId()
    try storage.setCredential(.init(keyId: "installation-key:synthetic", secret: "synthetic-installation-secret-32-bytes"))
    try storage.markInstallRecorded()
    return storage
  }
  private func preparation(_ storage: OpenMasuStorage) throws -> OpenMasuPreparedAppStorePurchase {
    OpenMasuPreparedAppStorePurchase(intentId: intent, appAccountToken: token, requestId: UUID(), productId: product,
      environment: .sandbox, installationId: try storage.installationId(), installationKeyId: try storage.credential()!.keyId)
  }
  private func json(_ value: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: value) }
  private func response() throws -> Data {
    try json(["intent_id": intent.uuidString, "app_account_token": token.uuidString,
      "product_id": product, "environment": "Sandbox", "state": "prepared"])
  }
  private func httpSdk(_ handler: @escaping PurchaseURLProtocol.Handler) throws -> (OpenMasuSDK, OpenMasuStorage) {
    let host = "\(UUID().uuidString.lowercased()).synthetic.invalid"
    PurchaseURLProtocol.register(host: host, handler: handler)
    addTeardownBlock { PurchaseURLProtocol.unregister(host: host) }
    let sessionConfiguration = URLSessionConfiguration.ephemeral
    sessionConfiguration.protocolClasses = [PurchaseURLProtocol.self]
    let session = URLSession(configuration: sessionConfiguration)
    addTeardownBlock { session.invalidateAndCancel() }
    let root = temporaryDirectory(), storage = try primedStorage(root)
    let config = configuration(endpoint: URL(string: "https://\(host)")!)
    let sdk = try OpenMasuSDK(configuration: config, storageRoot: root, transport: HmacHttpTransport(configuration: config, session: session))
    return (sdk, storage)
  }
  private func assertError(_ expected: OpenMasuError, operation: () async throws -> Void) async {
    do { try await operation(); XCTFail("expected \(expected)") }
    catch { XCTAssertEqual(error as? OpenMasuError, expected) }
  }
}

private func requestBody(_ request: URLRequest) throws -> Data {
  if let data = request.httpBody { return data }
  guard let stream = request.httpBodyStream else { throw OpenMasuError.responseInvalid }
  stream.open(); defer { stream.close() }
  var result = Data(), buffer = [UInt8](repeating: 0, count: 4096)
  while true {
    let count = stream.read(&buffer, maxLength: 4096)
    guard count >= 0 else { throw OpenMasuError.responseInvalid }
    if count == 0 { return result }
    result.append(contentsOf: buffer.prefix(count))
  }
}

private final class PurchaseRequestRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var requests: [(URLRequest, Data)] = []
  func append(_ request: URLRequest, _ data: Data) { lock.lock(); defer { lock.unlock() }; requests.append((request, data)) }
  func values() -> [(URLRequest, Data)] { lock.lock(); defer { lock.unlock() }; return requests }
}

private final class PurchaseURLProtocol: URLProtocol, @unchecked Sendable {
  typealias Handler = (URLRequest) throws -> (Int, Data)
  private static let registryLock = NSLock()
  private static var handlers: [String: Handler] = [:]
  static func register(host: String, handler: @escaping Handler) { registryLock.lock(); defer { registryLock.unlock() }; handlers[host] = handler }
  static func unregister(host: String) { registryLock.lock(); defer { registryLock.unlock() }; handlers.removeValue(forKey: host) }
  private static func handler(host: String) -> Handler? { registryLock.lock(); defer { registryLock.unlock() }; return handlers[host] }
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    do {
      guard let url = request.url, let handler = Self.handler(host: url.host ?? "") else { throw OpenMasuError.responseInvalid }
      let (status, data) = try handler(request)
      client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["content-type": "application/json"])!, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: data)
      client?.urlProtocolDidFinishLoading(self)
    } catch { client?.urlProtocol(self, didFailWithError: error) }
  }
  override func stopLoading() {}
}

private actor EventsOnlyTransport: OpenMasuTransport {
  private(set) var deliveries = 0
  func enroll(installationId: String) async throws -> InstallationCredential { .init(keyId: "synthetic-key", secret: "synthetic-secret") }
  func deliver(credential: InstallationCredential, events: [QueuedEvent]) async throws { deliveries += 1 }
  func deleteInstallation(credential: InstallationCredential, installationId: String) async throws {}
}

private actor PausablePurchaseTransport: OpenMasuAppStoreTransport {
  private var paused: String?
  private var started: XCTestExpectation?
  private var continuation: CheckedContinuation<Void, Never>?
  private(set) var preparations = 0
  private(set) var submissions = 0
  func pause(_ operation: String, started: XCTestExpectation) { paused = operation; self.started = started }
  func resume() { continuation?.resume(); continuation = nil }
  private func wait(_ operation: String) async {
    if paused == operation {
      paused = nil
      await withCheckedContinuation { continuation in self.continuation = continuation; started?.fulfill() }
    }
  }
  func enroll(installationId: String) async throws -> InstallationCredential { .init(keyId: "synthetic-\(installationId)", secret: "synthetic-secret") }
  func deliver(credential: InstallationCredential, events: [QueuedEvent]) async throws {}
  func deleteInstallation(credential: InstallationCredential, installationId: String) async throws { await wait("delete") }
  func prepareAppStorePurchase(credential: InstallationCredential, installationId: String, productId: String,
    requestId: UUID, revenueMeasurementConsent: Bool) async throws -> OpenMasuPreparedAppStorePurchase {
    preparations += 1
    await wait("prepare")
    return .init(intentId: UUID(), appAccountToken: UUID(), requestId: requestId, productId: productId,
      environment: .sandbox, installationId: installationId, installationKeyId: credential.keyId)
  }
  func submitAppStorePurchase(credential: InstallationCredential, prepared: OpenMasuPreparedAppStorePurchase,
    signedTransaction: String, revenueMeasurementConsent: Bool) async throws -> OpenMasuAppStoreSubmission {
    submissions += 1
    await wait("submit")
    return .init(intentId: prepared.intentId)
  }
}
