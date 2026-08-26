import Foundation

public actor OpenMasuSDK {
  private nonisolated let configuration: OpenMasuConfiguration
  private let storage: OpenMasuStorage
  private let transport: any OpenMasuTransport
  private let tokenProvider: any AdServicesTokenProviding
  private nonisolated let deepLinkRouter = DeepLinkRouter()

  public init(
    configuration: OpenMasuConfiguration,
    storageRoot: URL? = nil,
    transport: (any OpenMasuTransport)? = nil,
    tokenProvider: any AdServicesTokenProviding = DisabledAdServicesTokenProvider()
  ) throws {
    self.configuration = configuration
    self.storage = try OpenMasuStorage(root: storageRoot)
    self.transport = transport ?? HmacHttpTransport(configuration: configuration)
    self.tokenProvider = tokenProvider
  }

  public func initialize() async throws {
    guard try isCollectionEnabled() else { return }
    try storage.purgeConsentRequiredQueueIfBlocked()
    if try storage.consentBarrierActive() {
      try await flush()
      return
    }
    if try storage.isResetPending() {
      try await completePendingReset(installationId: storage.installationId())
      return
    }
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

  public nonisolated func setDeepLinkListener(_ listener: (@Sendable (OpenMasuDeepLink) -> Void)?) {
    deepLinkRouter.set(listener)
  }

  @discardableResult
  public nonisolated func handleDeepLink(_ url: URL) -> Bool {
    guard let value = parseDeepLink(url) else { return false }
    deepLinkRouter.deliver(value)
    Task { try? await self.recordDeepLink(value) }
    return true
  }

  public nonisolated func parseDeepLink(_ url: URL) -> OpenMasuDeepLink? {
    DeepLinkParser.direct(url, allowedHosts: configuration.deepLinkHosts, allowedSchemes: configuration.deepLinkSchemes)
  }

  @discardableResult
  public nonisolated func handleDeepLink(_ userActivity: NSUserActivity) -> Bool {
    guard userActivity.activityType == NSUserActivityTypeBrowsingWeb,
          let url = userActivity.webpageURL else { return false }
    return handleDeepLink(url)
  }

  public func trackCustomEvent(_ eventKey: String, attributes: [String: Any] = [:]) async throws {
    guard try isCollectionEnabled() else { return }
    guard eventKey.range(of: "^[a-z][a-z0-9_]{0,63}$", options: .regularExpression) != nil else {
      throw OpenMasuError.invalidEventKey
    }
    guard attributes.count <= 20, attributes.keys.allSatisfy({
      $0.range(of: "^[a-z][a-z0-9_]{0,63}$", options: .regularExpression) != nil
    }), JSONSerialization.isValidJSONObject(attributes) else { throw OpenMasuError.invalidAttributes }
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

  @available(*, deprecated, message: "Use trackSettledPurchase for installation-anchored settled purchases.")
  public func trackPurchase(
    transactionId: String,
    amountUnscaled: String,
    amountScale: Int,
    currency: String,
    financialStatus: String = "settled"
  ) async throws {
    guard try isCollectionEnabled() else { return }
    try validateLegacyMoney(amountUnscaled: amountUnscaled, amountScale: amountScale, currency: currency)
    guard ["settled", "pending", "reversed"].contains(financialStatus) else { throw OpenMasuError.invalidMoney }
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

  public func trackSettledPurchase(
    transactionId: String,
    amountUnscaled: String,
    amountScale: Int,
    currency: String
  ) async throws {
    guard try isCollectionEnabled() else { return }
    try validateIdentifier(transactionId)
    try validateMoney(amountUnscaled: amountUnscaled, amountScale: amountScale, currency: currency)
    let installationId = try storage.installationId()
    let payload: [String: Any] = [
      "event_name": "purchase",
      "transaction_id": transactionId,
      "amount_unscaled": amountUnscaled,
      "amount_scale": amountScale,
      "currency": currency,
      "financial_status": "settled",
      "installation_id": installationId,
    ]
    try enqueue(
      eventName: "purchase",
      purpose: "revenue_measurement",
      payloadJson: EventFactory.json(payload),
      eventId: EventFactory.commerceEventIdentifier(
        eventName: "purchase", installationId: installationId, transactionId: transactionId,
        originalTransactionId: nil, amountUnscaled: amountUnscaled, amountScale: amountScale, currency: currency
      )
    )
    try await flush()
  }

  public func trackRefund(
    transactionId: String,
    originalTransactionId: String,
    amountUnscaled: String,
    amountScale: Int,
    currency: String
  ) async throws {
    guard try isCollectionEnabled() else { return }
    try validateIdentifier(transactionId)
    try validateIdentifier(originalTransactionId)
    try validateMoney(amountUnscaled: amountUnscaled, amountScale: amountScale, currency: currency)
    let installationId = try storage.installationId()
    let payload: [String: Any] = [
      "event_name": "refund",
      "transaction_id": transactionId,
      "original_transaction_id": originalTransactionId,
      "amount_unscaled": amountUnscaled,
      "amount_scale": amountScale,
      "currency": currency,
      "financial_status": "settled",
      "installation_id": installationId,
    ]
    try enqueue(
      eventName: "refund",
      purpose: "revenue_measurement",
      payloadJson: EventFactory.json(payload),
      eventId: EventFactory.commerceEventIdentifier(
        eventName: "refund", installationId: installationId, transactionId: transactionId,
        originalTransactionId: originalTransactionId, amountUnscaled: amountUnscaled,
        amountScale: amountScale, currency: currency
      )
    )
    try await flush()
  }

  @available(*, deprecated, message: "Use the target-free overload; OpenMasu resolves the canonical purchase from originalTransactionId.")
  public func trackRefund(
    transactionId: String,
    originalTransactionId: String,
    correctionTargetRecordId: String,
    amountUnscaled: String,
    amountScale: Int,
    currency: String
  ) async throws {
    guard try isCollectionEnabled() else { return }
    try validateLegacyMoney(amountUnscaled: amountUnscaled, amountScale: amountScale, currency: currency)
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
      "event_key": "openmasu.conversion_value_updated",
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
      throw OpenMasuError.invalidAttributes
    }
    try storage.applyConsentState(state)
    try storage.purgeConsentRequiredQueueIfBlocked()
    try enqueue(eventName: "consent_changed", purpose: "fraud_prevention", payloadJson: EventFactory.json([
      "event_name": "consent_changed",
      "consent_state": state,
      "effective_at": EventFactory.canonicalNow(),
      "consent_policy_version": policyVersion,
    ]))
    if try isCollectionEnabled() {
      if (state == "granted" || state == "not_required"), try storage.isResetPending() {
        try await completePendingReset(installationId: storage.installationId())
      } else {
        try await flush()
      }
    }
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
    guard let credential = try storage.credential() else { throw OpenMasuError.resetRequiresEnrollment }
    try await transport.deleteInstallation(credential: credential, installationId: oldInstallationId)
    try storage.clearForReset()
    let newInstallationId = try storage.replaceInstallationId()
    try storage.markResetPending()
    try await completePendingReset(installationId: newInstallationId)
  }

  private func completePendingReset(installationId: String) async throws {
    if try storage.consentBarrierActive() { return }
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
    try storage.purgeConsentRequiredQueueIfBlocked()
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

  private func recordDeepLink(_ value: OpenMasuDeepLink) async throws {
    guard try isCollectionEnabled() else { return }
    try enqueue(
      eventName: "deep_link_open",
      purpose: "attribution",
      payloadJson: EventFactory.deepLink(installationId: storage.installationId(), value: value)
    )
    try await flush()
  }

  private func enqueue(eventName: String, purpose: String, payloadJson: String, eventId: String? = nil) throws {
    if try storage.consentBarrierActive(), Self.consentRequiredPurposes.contains(purpose) { return }
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
    guard amountUnscaled.range(of: "^[0-9]+$", options: .regularExpression) != nil,
          (0...18).contains(amountScale),
          currency.range(of: "^[A-Z]{3}$", options: .regularExpression) != nil
    else { throw OpenMasuError.invalidMoney }
  }

  private func validateLegacyMoney(amountUnscaled: String, amountScale: Int, currency: String) throws {
    guard amountUnscaled.range(of: "^-?[0-9]+$", options: .regularExpression) != nil,
          (0...18).contains(amountScale),
          currency.range(of: "^[A-Z]{3}$", options: .regularExpression) != nil
    else { throw OpenMasuError.invalidMoney }
  }

  private func validateIdentifier(_ value: String) throws {
    guard value.range(of: "^[A-Za-z0-9._:-]{1,128}$", options: .regularExpression) != nil
    else { throw OpenMasuError.invalidAttributes }
  }

  static func collectionDefault(bundle: Bundle, fallback: Bool) -> Bool {
    (bundle.object(forInfoDictionaryKey: "OpenMasuCollectionEnabledDefault") as? Bool) ?? fallback
  }

  private static let consentRequiredPurposes = Set(["attribution", "analytics", "revenue_measurement"])
}
