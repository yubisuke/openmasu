import Foundation

/// Local bookkeeping only. Neither the lease nor the stored state leaves this SDK.
public struct AppleConversionStateLease: Sendable {
  public let state: String?
  fileprivate let id: UUID
  fileprivate let revision: UInt64
  fileprivate let consentRevision: Int64?
}

public actor OpenMasuSDK {
  private nonisolated let configuration: OpenMasuConfiguration
  private nonisolated let storage: OpenMasuStorage
  private let transport: any OpenMasuTransport
  private let tokenProvider: any AdServicesTokenProviding
  private nonisolated let deepLinkRouter = DeepLinkRouter()
  private var purchaseContextRevision: UInt64 = 0
  private var purchaseResetInFlight = false
  private var appleConversionLease: UUID?

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
    if try storage.deletionJournal() != nil { try await resetInstallationId(); return }
    guard try isCollectionEnabled() else { return }
    try storage.purgeConsentRequiredQueueIfBlocked()
    if try storage.consentSnapshot("attribution").blocked {
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
    if let consent = try? storage.consentSnapshot("attribution"),
       let installationId = try? storage.installationId() {
      Task { try? await self.recordDeepLink(value, consent: consent, installationId: installationId) }
    }
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

  /// Initialize first. Reuse requestId after a timeout; never make a fallback appAccountToken.
  public func prepareAppStorePurchase(
    productId: String, requestId: UUID, revenueMeasurementConsent: Bool
  ) async throws -> OpenMasuPreparedAppStorePurchase {
    try AppStorePurchaseValidation.product(productId)
    let context = try appStorePurchaseContext(consent: revenueMeasurementConsent)
    guard let purchases = transport as? any OpenMasuAppStoreTransport else {
      throw OpenMasuError.purchaseTransportUnsupported
    }
    let prepared = try await purchases.prepareAppStorePurchase(
      credential: context.credential, installationId: context.installationId,
      productId: productId, requestId: requestId, revenueMeasurementConsent: true
    )
    try checkAppStorePurchaseContext(context)
    guard prepared.installationId == context.installationId,
          prepared.installationKeyId == context.credential.keyId,
          prepared.productId == productId, prepared.requestId == requestId
    else { throw OpenMasuError.responseInvalid }
    return prepared
  }

  /// Pending means durable server admission, not recognized revenue. No analytics event is queued.
  public func submitAppStorePurchase(
    prepared: OpenMasuPreparedAppStorePurchase, signedTransaction: String,
    revenueMeasurementConsent: Bool
  ) async throws -> OpenMasuAppStoreSubmission {
    try AppStorePurchaseValidation.signedTransaction(signedTransaction)
    let context = try appStorePurchaseContext(consent: revenueMeasurementConsent)
    guard prepared.installationId == context.installationId,
          prepared.installationKeyId == context.credential.keyId
    else { throw OpenMasuError.purchaseContextChanged }
    guard let purchases = transport as? any OpenMasuAppStoreTransport else {
      throw OpenMasuError.purchaseTransportUnsupported
    }
    let result = try await purchases.submitAppStorePurchase(
      credential: context.credential, prepared: prepared,
      signedTransaction: signedTransaction, revenueMeasurementConsent: true
    )
    try checkAppStorePurchaseContext(context)
    guard result.intentId == prepared.intentId else { throw OpenMasuError.responseInvalid }
    return result
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
    try await updateConsentScope(nil, state: state, policyVersion: policyVersion)
  }

  public func updateConsentForPurpose(_ purpose: String, state: String, policyVersion: String) async throws {
    guard OpenMasuStorage.consentPurposes.contains(purpose) else { throw OpenMasuError.invalidAttributes }
    try await updateConsentScope(purpose, state: state, policyVersion: policyVersion)
  }

  private func updateConsentScope(_ purpose: String?, state: String, policyVersion: String) async throws {
    let control = try storage.recordConsent(state: state, policyVersion: policyVersion, purpose: purpose,
      maxBytes: configuration.maxQueueBytes)
    if try storage.deletionJournal() == nil {
      _ = try storage.enqueue(control, capacity: QueueCapacity(maxRecords: configuration.maxQueueRecords, maxBytes: configuration.maxQueueBytes))
    }
    if try isCollectionEnabled() {
      if (state == "granted" || state == "not_required"), try storage.isResetPending() {
        try await completePendingReset(installationId: storage.installationId())
      } else {
        try await flush()
      }
    }
  }

  public func setCollectionEnabled(_ enabled: Bool) async throws {
    purchaseContextRevision &+= 1
    try storage.setCollectionEnabled(enabled)
    if !enabled { try storage.clearAppleConversionState() }
    if enabled { try await flush() }
  }

  public func isCollectionEnabled() throws -> Bool {
    try storage.deletionJournal() == nil && storage.collectionEnabled(default: Self.collectionDefault(
      bundle: .main,
      fallback: configuration.collectionEnabledByDefault
    ))
  }

  /// Local opt-in only; server expiry and deployment purpose remain authoritative.
  public func setSyntheticValidationSession(token: String, expiresAtMs: Int64) throws {
    guard transport is any OpenMasuSyntheticValidationTransport else { throw OpenMasuSyntheticValidationError.transportUnsupported }
    let session = SyntheticValidationSession(token: token, expiresAtMs: expiresAtMs)
    guard session.isActive(nowMs: Int64(Date().timeIntervalSince1970 * 1_000)) else { throw OpenMasuSyntheticValidationError.invalidSession }
    try storage.setSyntheticValidationSession(session)
  }

  public func clearSyntheticValidationSession() throws { try storage.setSyntheticValidationSession(nil) }

  /// Returns one bounded page. No enrollment, event queue, persistence or automatic retry.
  public func requestPrivacyPage(_ requestType: OpenMasuPrivacyRequestType, cursor: String? = nil,
    pageSize: Int = 200) async -> OpenMasuPrivacyResult {
    guard OpenMasuPrivacyPage.validRequest(cursor: cursor, pageSize: pageSize) else { return .init(.invalidRequest) }
    do {
      guard try !purchaseResetInFlight && storage.deletionJournal() == nil && !storage.isResetPending() else { return .init(.resetPending) }
      guard let capable = transport as? any OpenMasuPrivacyTransport else { return .init(.unsupported) }
      guard let credential = try storage.credential() else { return .init(.notEnrolled) }
      let installationId = try storage.installationId(), revision = purchaseContextRevision
      let consentCounter = try storage.consentCounter()
      let data = try await capable.privacyPage(credential: credential, installationId: installationId,
        requestType: requestType, cursor: cursor, pageSize: pageSize)
      guard try revision == purchaseContextRevision && consentCounter == storage.consentCounter() && !purchaseResetInFlight && storage.deletionJournal() == nil &&
        !storage.isResetPending() && storage.installationId() == installationId && storage.credential() == credential
      else { return .init(.contextChanged) }
      let page = try OpenMasuPrivacyPage.parse(data, requestType: requestType, pageSize: pageSize)
      return .init(page.complete ? .complete : .pageReady, page: page)
    } catch { return .init(.requestFailed) }
  }

  public func resetInstallationId() async throws {
    try clearSyntheticValidationSession()
    guard !purchaseResetInFlight else { throw OpenMasuError.purchaseContextChanged }
    purchaseContextRevision &+= 1
    purchaseResetInFlight = true
    defer { purchaseResetInFlight = false }
    if try storage.deletionJournal() == nil && storage.isResetPending() {
      try await completePendingReset(installationId: storage.installationId())
      return
    }
    if try storage.deletionJournal() == nil && storage.credential() == nil { throw OpenMasuError.resetRequiresEnrollment }
    let journal = try storage.beginDeletion()
    try storage.discardQueuedMeasurement()
    if journal.replacementId == nil {
      guard let credential = try storage.credential() else { throw OpenMasuError.resetRequiresEnrollment }
      if let asynchronous = transport as? any OpenMasuDeletionTransport {
        var state = try await observeTransport(.deletionStatus) { try await asynchronous.deletionStatus(receipt: journal.receipt) }
        if state == .missing {
          state = try await observeTransport(.deletion) {
            try await asynchronous.beginDeletion(credential: credential, installationId: journal.installationId, receipt: journal.receipt)
          }
        }
        guard state == .completed else { throw OpenMasuError.resetPending }
      } else {
        try await observeTransport(.deletion) { try await transport.deleteInstallation(credential: credential, installationId: journal.installationId) }
      }
    }
    let newInstallationId = try storage.completeDeletion()
    try await completePendingReset(installationId: newInstallationId)
  }

  private func completePendingReset(installationId: String) async throws {
    if try storage.consentSnapshot("attribution").blocked || !isCollectionEnabled() { return }
    if try storage.credential() == nil {
      _ = try await ensureCredential()
    }
    guard try storage.installationId() == installationId && storage.deletionJournal() == nil else { throw OpenMasuError.purchaseContextChanged }
    if try !storage.isInstallRecorded() {
      let eventId = "event:reset:\(installationId)"
      if try !storage.hasQueuedEvent(eventId) { try enqueue(
        eventName: "install",
        purpose: "attribution",
        payloadJson: EventFactory.install(
          installationId: installationId,
          sdkVersion: configuration.wrapperVersion ?? configuration.sdkVersion,
          origin: "identifier_reset",
          adServicesToken: nil,
          conversionSchemaVersion: configuration.conversionSchemaVersion,
          conversionSchemaSha256: configuration.conversionSchemaSha256
        ),
        eventId: eventId
      ) }
      guard try storage.hasQueuedEvent(eventId) else { throw OpenMasuError.resetPending }
      try storage.markInstallRecorded()
    }
    try storage.clearResetPending()
    try await flush()
  }

  public func flush() async throws {
    if try storage.deletionJournal() != nil {
      guard !purchaseResetInFlight else { throw OpenMasuError.resetPending }
      try await resetInstallationId()
      return
    }
    guard try isCollectionEnabled() else { return }
    if try storage.isResetPending() && !storage.consentSnapshot("attribution").blocked {
      try await completePendingReset(installationId: storage.installationId())
      return
    }
    try storage.purgeConsentRequiredQueueIfBlocked()
    let queued = try storage.pending(limit: 97)
    guard !queued.isEmpty else { return }
    let installationId = try storage.installationId()
    let credential = try await ensureCredential()
    guard try isCollectionEnabled() && storage.deletionJournal() == nil && storage.installationId() == installationId else { return }
    let current = try queued.filter { event in
      guard Self.consentRequiredPurposes.contains(event.processingPurposeId) else { return true }
      let consent = try storage.consentSnapshot(event.processingPurposeId)
      return !consent.blocked && consent.revision == event.consentRevision
    }
    var seen = Set<String>()
    let events = try (storage.consentDeclarations() + current).filter { seen.insert($0.eventId).inserted }.map { event in
      guard event.eventName == "consent_changed" else { return event }
      let id = "event:consent:" + SdkRequestSigner.sha256(Data((installationId + "\n" + credential.keyId + "\n" + event.eventId).utf8))
      return QueuedEvent(eventId: id, eventName: event.eventName, processingPurposeId: event.processingPurposeId,
        payloadJson: event.payloadJson, occurredAt: event.occurredAt, processingSequence: event.processingSequence,
        enqueuedAtMs: event.enqueuedAtMs, consentRevision: event.consentRevision)
    }
    guard !events.isEmpty else { return }
    let session = try storage.syntheticValidationSession()
    try await observeTransport(.delivery) {
      if let session, session.isActive(nowMs: Int64(Date().timeIntervalSince1970 * 1_000)) {
        guard let validation = transport as? any OpenMasuSyntheticValidationTransport else { throw OpenMasuSyntheticValidationError.transportUnsupported }
        try await validation.deliverForSyntheticValidation(credential: credential, events: events, sessionToken: session.token)
      } else {
        try await transport.deliver(credential: credential, events: events)
      }
    }
    try storage.deleteDelivered(queued)
  }

  public func installationIdForMeasurement() throws -> String { try storage.installationId() }
  public func pendingEvents() throws -> [QueuedEvent] { try storage.pending(limit: 10_000) }
  public func pendingCount() throws -> Int { try storage.count() }
  public func queueHealth() throws -> OpenMasuQueueHealth { try storage.queueHealth() }
  /// Reads local state only; never generates an identifier, enrolls, or sends.
  public func diagnosticsSnapshot() throws -> OpenMasuDiagnosticsSnapshot {
    let queue = try storage.queueHealth()
    let attempt = try storage.diagnosticAttempt()
    let enabled = try storage.collectionEnabled(default: Self.collectionDefault(bundle: .main, fallback: configuration.collectionEnabledByDefault))
    let barrier = try storage.consentBarrierActive()
    let reset = try storage.deletionJournal() != nil || storage.isResetPending()
    let retry: OpenMasuRetryState = reset ? .resetPending : !enabled ? .collectionBlocked : barrier ? .consentBlocked : queue.pendingCount > 0 ? .pending : .none
    return OpenMasuDiagnosticsSnapshot(
      collectionEnabled: enabled, consentBarrierActive: barrier, resetPending: reset, enrolled: try storage.credential() != nil,
      lastAttemptAtMs: attempt.atMs, lastOperation: attempt.operation, lastResult: attempt.result, httpClass: attempt.httpClass,
      retryState: retry, queue: queue, purposeConsent: try OpenMasuStorage.consentPurposes.map(storage.consentSnapshot)
    )
  }
  public func storageRoot() -> URL { storage.root }

  public func beginAppleConversionState(consentGranted: Bool, schemaVersion: String, schemaDigest: String) throws -> AppleConversionStateLease {
    guard configuration.conversionSchemaVersion == schemaVersion, configuration.conversionSchemaSha256 == schemaDigest else {
      throw OpenMasuError.conversionSchema("conversion_configuration_mismatch")
    }
    let consent = try storage.consentSnapshot("attribution")
    guard consentGranted, !consent.blocked else { throw OpenMasuError.conversionSchema("conversion_consent_required") }
    guard try isCollectionEnabled() else { throw OpenMasuError.collectionDisabled }
    guard !purchaseResetInFlight, try !storage.isResetPending(), appleConversionLease == nil else {
      throw OpenMasuError.conversionSchema("conversion_context_busy")
    }
    let state = try storage.appleConversionState()
    let id = UUID()
    appleConversionLease = id
    return AppleConversionStateLease(state: state, id: id, revision: purchaseContextRevision, consentRevision: consent.revision)
  }

  public func finishAppleConversionState(_ lease: AppleConversionStateLease, state: String) throws {
    guard appleConversionLease == lease.id else { throw OpenMasuError.conversionSchema("conversion_context_changed") }
    defer { appleConversionLease = nil }
    let consent = try storage.consentSnapshot("attribution")
    guard lease.revision == purchaseContextRevision, !consent.blocked, lease.consentRevision == consent.revision,
          try isCollectionEnabled(), !purchaseResetInFlight else {
      throw OpenMasuError.conversionSchema("conversion_context_changed")
    }
    guard state.utf8.count <= 262_144 else { throw OpenMasuError.conversionSchema("conversion_state_limit") }
    try storage.setAppleConversionState(state)
  }

  public func cancelAppleConversionState(_ lease: AppleConversionStateLease) {
    if appleConversionLease == lease.id { appleConversionLease = nil }
  }

  private func ensureCredential() async throws -> InstallationCredential {
    if let credential = try storage.credential() { return credential }
    let installationId = try storage.installationId()
    let credential = try await observeTransport(.enrollment) { try await transport.enroll(installationId: installationId) }
    guard try storage.installationId() == installationId && storage.deletionJournal() == nil else { throw OpenMasuError.purchaseContextChanged }
    try storage.setCredential(credential)
    return credential
  }

  private func observeTransport<T>(_ operation: OpenMasuDiagnosticOperation, work: () async throws -> T) async throws -> T {
    var attempt = DiagnosticAttempt(atMs: Int64(Date().timeIntervalSince1970 * 1_000), operation: operation, result: .inFlight)
    // Persist before await: the actor may serve a diagnostic read during network I/O.
    try? storage.setDiagnosticAttempt(attempt)
    do {
      let value = try await work()
      let http = transport is HmacHttpTransport
      attempt.result = http ? (operation == .delivery ? .accepted : .httpResponse) : .customSuccess
      attempt.httpClass = http ? ((value as? DeletionStatus) == .missing ? .http4xx : .http2xx) : .none
      try? storage.setDiagnosticAttempt(attempt)
      return value
    } catch {
      attempt.result = .customFailure
      if let failure = error as? OpenMasuError, case .transport(let status) = failure {
        switch status {
        case 401, 403: attempt.result = .authenticationRejected
        case 429: attempt.result = .rateLimited
        case 500...599: attempt.result = .serverError
        case 400...499: attempt.result = .requestRejected
        default: attempt.result = .unexpectedResponse
        }
        switch status {
        case 200...299: attempt.httpClass = .http2xx
        case 400...499: attempt.httpClass = .http4xx
        case 500...599: attempt.httpClass = .http5xx
        default: attempt.httpClass = .other
        }
      } else if error is URLError {
        attempt.result = .networkUnavailable
      } else if transport is HmacHttpTransport {
        attempt.result = .unexpectedResponse
      }
      try? storage.setDiagnosticAttempt(attempt)
      throw error
    }
  }

  private struct AppStorePurchaseContext {
    let revision: UInt64
    let consentRevision: Int64?
    let installationId: String
    let credential: InstallationCredential
  }

  private func appStorePurchaseContext(consent: Bool) throws -> AppStorePurchaseContext {
    guard consent else { throw OpenMasuError.purchaseConsentRequired }
    guard !purchaseResetInFlight, try storage.deletionJournal() == nil, try !storage.isResetPending() else { throw OpenMasuError.purchaseContextChanged }
    guard try isCollectionEnabled() else { throw OpenMasuError.collectionDisabled }
    let consent = try storage.consentSnapshot("revenue_measurement")
    guard !consent.blocked else { throw OpenMasuError.purchaseConsentRequired }
    guard try storage.isInstallRecorded(), let credential = try storage.credential() else {
      throw OpenMasuError.resetRequiresEnrollment
    }
    return AppStorePurchaseContext(
      revision: purchaseContextRevision, consentRevision: consent.revision, installationId: try storage.installationId(), credential: credential
    )
  }

  private func checkAppStorePurchaseContext(_ before: AppStorePurchaseContext) throws {
    guard before.revision == purchaseContextRevision else { throw OpenMasuError.purchaseContextChanged }
    let current = try appStorePurchaseContext(consent: true)
    guard before.installationId == current.installationId, before.credential == current.credential,
          before.consentRevision == current.consentRevision
    else { throw OpenMasuError.purchaseContextChanged }
  }

  private func recordDeepLink(_ value: OpenMasuDeepLink, consent: OpenMasuPurposeConsent, installationId: String) async throws {
    guard try isCollectionEnabled() else { return }
    let current = try storage.consentSnapshot("attribution")
    guard !consent.blocked, !current.blocked, consent.revision == current.revision,
          try storage.installationId() == installationId else { return }
    try enqueue(
      eventName: "deep_link_open",
      purpose: "attribution",
      payloadJson: EventFactory.deepLink(installationId: installationId, value: value)
    )
    try await flush()
  }

  private func enqueue(eventName: String, purpose: String, payloadJson: String, eventId: String? = nil) throws {
    if try storage.deletionJournal() != nil { return }
    let consent = try storage.consentSnapshot(purpose)
    if consent.blocked { return }
    try storage.purgeConsentRequiredQueueIfBlocked()
    _ = try storage.enqueue(QueuedEvent(
      eventId: eventId ?? EventFactory.identifier("event"),
      eventName: eventName,
      processingPurposeId: purpose,
      payloadJson: payloadJson,
      occurredAt: EventFactory.canonicalNow(),
      processingSequence: storage.nextSequence(),
      enqueuedAtMs: Int64(Date().timeIntervalSince1970 * 1_000),
      consentRevision: consent.revision
    ), capacity: QueueCapacity(
      maxRecords: configuration.maxQueueRecords,
      maxBytes: configuration.maxQueueBytes
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
