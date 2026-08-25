import Foundation

public actor OpenMmpSDK {
  private let configuration: OpenMmpConfiguration
  private let storage: OpenMmpStorage
  private let transport: any OpenMmpTransport
  private let tokenProvider: any AdServicesTokenProviding

  public init(
    configuration: OpenMmpConfiguration,
    storageRoot: URL? = nil,
    transport: (any OpenMmpTransport)? = nil,
    tokenProvider: any AdServicesTokenProviding = DisabledAdServicesTokenProvider()
  ) throws {
    self.configuration = configuration
    self.storage = try OpenMmpStorage(root: storageRoot)
    self.transport = transport ?? HmacHttpTransport(configuration: configuration)
    self.tokenProvider = tokenProvider
  }

  public func initialize() async throws {
    guard try isCollectionEnabled() else { return }
    if !(try storage.isInstallRecorded()) {
      let token: String? = (try? tokenProvider.attributionToken()) ?? nil
      try enqueue(
        eventName: "install",
        purpose: "attribution",
        payloadJson: EventFactory.install(
          installationId: storage.installationId(),
          sdkVersion: configuration.wrapperVersion ?? configuration.sdkVersion,
          origin: "ios_first_launch",
          adServicesToken: token,
          conversionSchemaVersion: configuration.conversionSchemaVersion,
          conversionSchemaSha256: configuration.conversionSchemaSha256
        )
      )
      try storage.markInstallRecorded()
    }
    try await flush()
  }

  public func startSession() async throws {
    guard try isCollectionEnabled() else { return }
    try enqueue(
      eventName: "session_start",
      purpose: "analytics",
      payloadJson: EventFactory.json([
        "event_name": "session_start",
        "installation_id": storage.installationId(),
        "session_id": EventFactory.identifier("session"),
      ])
    )
    try await flush()
  }

  public func trackCustomEvent(_ eventKey: String, attributes: [String: Any] = [:]) async throws {
    guard try isCollectionEnabled() else { return }
    guard eventKey.range(of: "^[a-z][a-z0-9_]{0,63}$", options: .regularExpression) != nil else {
      throw OpenMmpError.invalidEventKey
    }
    guard attributes.count <= 20, attributes.keys.allSatisfy({
      $0.range(of: "^[a-z][a-z0-9_]{0,63}$", options: .regularExpression) != nil
    }), JSONSerialization.isValidJSONObject(attributes) else { throw OpenMmpError.invalidAttributes }
    try enqueue(
      eventName: "custom_event",
      purpose: "analytics",
      payloadJson: EventFactory.json([
        "event_name": "custom_event",
        "installation_id": storage.installationId(),
        "event_key": eventKey,
        "attributes": attributes,
      ])
    )
    try await flush()
  }

  public func trackPurchase(
    transactionId: String,
    amountUnscaled: String,
    amountScale: Int,
    currency: String,
    financialStatus: String = "settled"
  ) async throws {
    guard try isCollectionEnabled() else { return }
    try validateMoney(amountUnscaled: amountUnscaled, amountScale: amountScale, currency: currency)
    guard ["settled", "pending", "reversed"].contains(financialStatus) else { throw OpenMmpError.invalidMoney }
    try enqueue(eventName: "purchase", purpose: "revenue_measurement", payloadJson: EventFactory.json([
      "event_name": "purchase",
      "transaction_id": transactionId,
      "amount_unscaled": amountUnscaled,
      "amount_scale": amountScale,
      "currency": currency,
      "financial_status": financialStatus,
    ]))
    try await flush()
  }

  public func trackRefund(
    transactionId: String,
    originalTransactionId: String,
    correctionTargetRecordId: String,
    amountUnscaled: String,
    amountScale: Int,
    currency: String
  ) async throws {
    guard try isCollectionEnabled() else { return }
    try validateMoney(amountUnscaled: amountUnscaled, amountScale: amountScale, currency: currency)
    try enqueue(eventName: "refund", purpose: "revenue_measurement", payloadJson: EventFactory.json([
      "event_name": "refund",
      "transaction_id": transactionId,
      "original_transaction_id": originalTransactionId,
      "correction_target_record_id": correctionTargetRecordId,
      "amount_unscaled": amountUnscaled,
      "amount_scale": amountScale,
      "currency": currency,
      "financial_status": "reversed",
    ]))
    try await flush()
  }

  public func enqueueAdRevenue(payload: [String: Any], eventId: String? = nil) async throws {
    guard try isCollectionEnabled() else { return }
    try enqueue(
      eventName: "ad_revenue",
      purpose: "revenue_measurement",
      payloadJson: EventFactory.json(payload),
      eventId: eventId
    )
    try await flush()
  }

  public func recordConversionValueUpdate(
    schemaVersion: String,
    fineValue: Int,
    coarseValue: String,
    lockPostback: Bool
  ) async throws {
    guard try isCollectionEnabled() else { return }
    try enqueue(eventName: "custom_event", purpose: "analytics", payloadJson: EventFactory.json([
      "event_name": "custom_event",
      "installation_id": storage.installationId(),
      "event_key": "openmmp.conversion_value_updated",
      "attributes": [
        "schema_version": schemaVersion,
        "fine_value": fineValue,
        "coarse_value": coarseValue,
        "lock_postback": lockPostback,
      ],
    ]))
    try await flush()
  }

  public func updateConsent(state: String, policyVersion: String) async throws {
    guard ["granted", "denied", "withdrawn", "not_required", "unknown"].contains(state) else {
      throw OpenMmpError.invalidAttributes
    }
    if state == "withdrawn" || state == "denied" {
      try storage.purge(processingPurposes: ["attribution", "analytics", "revenue_measurement"])
    }
    try enqueue(eventName: "consent_changed", purpose: "fraud_prevention", payloadJson: EventFactory.json([
      "event_name": "consent_changed",
      "consent_state": state,
      "effective_at": EventFactory.canonicalNow(),
      "consent_policy_version": policyVersion,
    ]))
    if try isCollectionEnabled() { try await flush() }
  }

  public func setCollectionEnabled(_ enabled: Bool) async throws {
    try storage.setCollectionEnabled(enabled)
    if enabled { try await flush() }
  }

  public func isCollectionEnabled() throws -> Bool {
    try storage.collectionEnabled(default: Self.collectionDefault(
      bundle: .main,
      fallback: configuration.collectionEnabledByDefault
    ))
  }

  public func resetInstallationId() async throws {
    if try storage.isResetPending() {
      try await completePendingReset(installationId: storage.installationId())
      return
    }
    let oldInstallationId = try storage.installationId()
    guard let credential = try storage.credential() else { throw OpenMmpError.resetRequiresEnrollment }
    try await transport.deleteInstallation(credential: credential, installationId: oldInstallationId)
    try storage.clearForReset()
    let newInstallationId = try storage.replaceInstallationId()
    try storage.markResetPending()
    try await completePendingReset(installationId: newInstallationId)
  }

  private func completePendingReset(installationId: String) async throws {
    if try storage.credential() == nil {
      try storage.setCredential(try await transport.enroll(installationId: installationId))
    }
    if try !storage.isInstallRecorded() {
      try enqueue(
        eventName: "install",
        purpose: "attribution",
        payloadJson: EventFactory.install(
          installationId: installationId,
          sdkVersion: configuration.wrapperVersion ?? configuration.sdkVersion,
          origin: "identifier_reset",
          adServicesToken: nil,
          conversionSchemaVersion: configuration.conversionSchemaVersion,
          conversionSchemaSha256: configuration.conversionSchemaSha256
        )
      )
      try storage.markInstallRecorded()
    }
    try await flush()
    try storage.clearResetPending()
  }

  public func flush() async throws {
    guard try isCollectionEnabled() else { return }
    let events = try storage.pending(limit: 100)
    guard !events.isEmpty else { return }
    let credential = try await ensureCredential()
    try await transport.deliver(credential: credential, events: events)
    try storage.delete(eventIds: events.map(\.eventId))
  }

  public func installationIdForMeasurement() throws -> String { try storage.installationId() }
  public func pendingEvents() throws -> [QueuedEvent] { try storage.pending(limit: 10_000) }
  public func pendingCount() throws -> Int { try storage.count() }
  public func storageRoot() -> URL { storage.root }

  private func ensureCredential() async throws -> InstallationCredential {
    if let credential = try storage.credential() { return credential }
    let credential = try await transport.enroll(installationId: storage.installationId())
    try storage.setCredential(credential)
    return credential
  }

  private func enqueue(eventName: String, purpose: String, payloadJson: String, eventId: String? = nil) throws {
    try storage.enqueue(QueuedEvent(
      eventId: eventId ?? EventFactory.identifier("event"),
      eventName: eventName,
      processingPurposeId: purpose,
      payloadJson: payloadJson,
      occurredAt: EventFactory.canonicalNow(),
      processingSequence: storage.nextSequence(),
      enqueuedAtMs: Int64(Date().timeIntervalSince1970 * 1_000)
    ))
  }

  private func validateMoney(amountUnscaled: String, amountScale: Int, currency: String) throws {
    guard amountUnscaled.range(of: "^-?[0-9]+$", options: .regularExpression) != nil,
          (0...18).contains(amountScale),
          currency.range(of: "^[A-Z]{3}$", options: .regularExpression) != nil
    else { throw OpenMmpError.invalidMoney }
  }

  static func collectionDefault(bundle: Bundle, fallback: Bool) -> Bool {
    (bundle.object(forInfoDictionaryKey: "OpenMmpCollectionEnabledDefault") as? Bool) ?? fallback
  }
}
