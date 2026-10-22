import Foundation
#if canImport(OpenMasuAppleAds)
import OpenMasuAppleAds
#endif
#if canImport(OpenMasuApplePostback)
import OpenMasuApplePostback
#endif
#if canImport(OpenMasuCore)
import OpenMasuCore
#endif
#if canImport(OpenMasuMax)
import OpenMasuMax
#endif

public typealias OpenMasuCStringCallback = @convention(c) (Int64, UnsafePointer<CChar>?) -> Void

private enum BridgeState {
  static let lock = NSLock()
  static var sdk: OpenMasuSDK?
  static var conversionController: ConversionValueController?

  static func set(_ value: OpenMasuSDK, conversionController valueController: ConversionValueController) {
    lock.lock(); sdk = value; conversionController = valueController; lock.unlock()
  }

  static func get() -> OpenMasuSDK? {
    lock.lock(); defer { lock.unlock() }
    return sdk
  }

  static func getConversionController() -> ConversionValueController? {
    lock.lock(); defer { lock.unlock() }
    return conversionController
  }
}

private func callback(_ callback: OpenMasuCStringCallback?, requestId: Int64, value: String) {
  guard let callback else { return }
  DispatchQueue.main.async {
    value.withCString { callback(requestId, $0) }
  }
}

// The bridge carries private preparation state, not purchase verification or an entitlement.
// Keep failures closed: Error descriptions can contain transport bodies or purchase evidence.
enum AppStorePurchaseBridge {
  static func failure(_ error: Error) -> String {
    let code: String
    switch error as? OpenMasuError {
    case .purchaseConsentRequired: code = "consent_required"
    case .purchaseContextChanged: code = "context_changed"
    case .collectionDisabled: code = "collection_disabled"
    case .resetRequiresEnrollment: code = "not_initialized"
    case .purchaseTransportUnsupported: code = "unsupported"
    case .invalidAttributes: code = "invalid_purchase"
    case .responseInvalid: code = "response_invalid"
    case .transport: code = "transport_failed"
    default: code = "purchase_failed"
    }
    return "state=not_submitted&error=\(code)"
  }

  static func prepare(
    sdk: OpenMasuSDK, productId: String, purchaseRequestId: String, consent: Bool
  ) async -> String {
    guard let requestId = UUID(uuidString: purchaseRequestId) else {
      return failure(OpenMasuError.invalidAttributes)
    }
    do {
      let prepared = try await sdk.prepareAppStorePurchase(
        productId: productId, requestId: requestId, revenueMeasurementConsent: consent
      )
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.sortedKeys]
      let encoded = try encoder.encode(prepared).base64EncodedString()
      let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
      guard let escaped = encoded.addingPercentEncoding(withAllowedCharacters: unreserved) else {
        return failure(OpenMasuError.responseInvalid)
      }
      return "state=prepared&prepared=\(escaped)&app_account_token=\(prepared.appAccountToken.uuidString.lowercased())"
    } catch { return failure(error) }
  }

  static func submit(
    sdk: OpenMasuSDK, encodedPreparation: String, signedTransaction: String, consent: Bool
  ) async -> String {
    // The closed preparation DTO is small; reject oversized input before decoding it.
    guard encodedPreparation.utf8.count <= 8_192,
          let data = Data(base64Encoded: encodedPreparation),
          let prepared = try? JSONDecoder().decode(OpenMasuPreparedAppStorePurchase.self, from: data)
    else { return failure(OpenMasuError.invalidAttributes) }
    do {
      _ = try await sdk.submitAppStorePurchase(
        prepared: prepared, signedTransaction: signedTransaction, revenueMeasurementConsent: consent
      )
      return "state=pending"
    } catch { return failure(error) }
  }
}

@_cdecl("openmasu_ios_initialize")
public func openmasuIOSInitialize(
  _ endpoint: UnsafePointer<CChar>?,
  _ sdkKeyId: UnsafePointer<CChar>?,
  _ sdkSecret: UnsafePointer<CChar>?,
  _ requestId: Int64,
  _ callbackValue: OpenMasuCStringCallback?
) {
  guard let endpoint, let sdkKeyId, let sdkSecret,
        let endpointURL = URL(string: String(cString: endpoint))
  else { callback(callbackValue, requestId: requestId, value: "error:configuration_invalid"); return }
  do {
    guard let schemaURL = OpenMasuConversionResources.defaultSchemaURL else {
      callback(callbackValue, requestId: requestId, value: "error:conversion_schema_missing")
      return
    }
    let schema = try ConversionSchema(data: Data(contentsOf: schemaURL))
    let configuration = OpenMasuConfiguration(
      endpoint: endpointURL,
      sdkKeyId: String(cString: sdkKeyId),
      sdkSecret: String(cString: sdkSecret),
      wrapperVersion: "unity-0.3.0-rc.2",
      conversionSchemaVersion: schema.schemaVersion,
      conversionSchemaSha256: schema.sha256,
      deepLinkHosts: Set(Bundle.main.object(forInfoDictionaryKey: "OpenMasuLinkHosts") as? [String] ?? []),
      deepLinkSchemes: Set(Bundle.main.object(forInfoDictionaryKey: "OpenMasuLinkSchemes") as? [String] ?? [])
    )
    let sdk = try OpenMasuSDK(
      configuration: configuration,
      tokenProvider: SystemAdServicesTokenProvider()
    )
    BridgeState.set(
      sdk,
      conversionController: ConversionValueController(
        schema: schema,
        updater: SystemAppleConversionUpdater()
      )
    )
    Task {
      do { try await sdk.initialize(); callback(callbackValue, requestId: requestId, value: "ok") }
      catch { callback(callbackValue, requestId: requestId, value: "error:initialize_failed") }
    }
  } catch {
    callback(callbackValue, requestId: requestId, value: "error:storage_failed")
  }
}

@_cdecl("openmasu_ios_record_conversion")
public func openmasuIOSRecordConversion(
  _ eventName: UnsafePointer<CChar>?,
  _ targetMask: Int32,
  _ conversionTag: UnsafePointer<CChar>?,
  _ requestId: Int64,
  _ callbackValue: OpenMasuCStringCallback?
) {
  guard let controller = BridgeState.getConversionController(), let eventName else {
    callback(callbackValue, requestId: requestId, value: "error:not_initialized")
    return
  }
  guard targetMask > 0, targetMask & ~3 == 0 else {
    callback(callbackValue, requestId: requestId, value: "error:conversion_targets_invalid")
    return
  }
  let tag = conversionTag.map(String.init(cString:))
  guard tag == nil || (targetMask == 2 && tag?.isEmpty == false) else {
    callback(callbackValue, requestId: requestId, value: "error:conversion_tag_invalid")
    return
  }
  var targets: [AppleConversionType] = []
  if targetMask & 1 != 0 { targets.append(.install) }
  if targetMask & 2 != 0 { targets.append(.reengagement) }
  let eventNameValue = String(cString: eventName)
  guard eventNameValue.range(of: "^[A-Za-z0-9._:-]{1,128}$", options: .regularExpression) != nil else {
    callback(callbackValue, requestId: requestId, value: "error:conversion_event_name_invalid")
    return
  }
  Task {
    do {
      _ = try await controller.record(
        eventName: eventNameValue,
        conversionTypes: targets,
        conversionTag: tag
      )
      callback(callbackValue, requestId: requestId, value: "ok")
    } catch {
      callback(callbackValue, requestId: requestId, value: "error:conversion_update_failed")
    }
  }
}

@_cdecl("openmasu_ios_handle_deep_link")
public func openmasuIOSHandleDeepLink(
  _ urlValue: UnsafePointer<CChar>?,
  _ requestId: Int64,
  _ callbackValue: OpenMasuCStringCallback?
) {
  guard let sdk = BridgeState.get(), let urlValue,
        let url = URL(string: String(cString: urlValue)) else {
    callback(callbackValue, requestId: requestId, value: "error:deep_link_invalid")
    return
  }
  guard let value = sdk.parseDeepLink(url), sdk.handleDeepLink(url) else {
    callback(callbackValue, requestId: requestId, value: "error:deep_link_unhandled")
    return
  }
  var components = URLComponents()
  components.queryItems = [
    value.value.map { URLQueryItem(name: "value", value: $0) },
    URLQueryItem(name: "open_source", value: value.openSource),
    URLQueryItem(name: "destination_status", value: value.destinationStatus),
    URLQueryItem(name: "link_slug", value: value.linkSlug),
  ].compactMap { $0 } + value.parameters.sorted(by: { $0.key < $1.key }).map {
    URLQueryItem(name: "p_\($0.key)", value: $0.value)
  }
  callback(callbackValue, requestId: requestId, value: components.percentEncodedQuery ?? "error:deep_link_encoding")
}

@_cdecl("openmasu_ios_track_custom_event")
public func openmasuIOSTrackCustomEvent(
  _ eventKey: UnsafePointer<CChar>?,
  _ requestId: Int64,
  _ callbackValue: OpenMasuCStringCallback?
) {
  guard let eventKey, let sdk = BridgeState.get() else {
    callback(callbackValue, requestId: requestId, value: "error:not_initialized")
    return
  }
  let eventKeyValue = String(cString: eventKey)
  Task {
    do { try await sdk.trackCustomEvent(eventKeyValue); callback(callbackValue, requestId: requestId, value: "ok") }
    catch { callback(callbackValue, requestId: requestId, value: "error:track_failed") }
  }
}

@_cdecl("openmasu_ios_track_purchase")
public func openmasuIOSTrackPurchase(
  _ transactionId: UnsafePointer<CChar>?,
  _ amountUnscaled: UnsafePointer<CChar>?,
  _ amountScale: Int32,
  _ currency: UnsafePointer<CChar>?,
  _ requestId: Int64,
  _ callbackValue: OpenMasuCStringCallback?
) {
  guard let sdk = BridgeState.get(), let transactionId, let amountUnscaled, let currency else {
    callback(callbackValue, requestId: requestId, value: "error:not_initialized_or_invalid_purchase")
    return
  }
  let transactionIdValue = String(cString: transactionId)
  let amountUnscaledValue = String(cString: amountUnscaled)
  let currencyValue = String(cString: currency)
  Task {
    do {
      try await sdk.trackSettledPurchase(
        transactionId: transactionIdValue,
        amountUnscaled: amountUnscaledValue,
        amountScale: Int(amountScale),
        currency: currencyValue
      )
      callback(callbackValue, requestId: requestId, value: "ok")
    } catch {
      callback(callbackValue, requestId: requestId, value: "error:purchase_failed")
    }
  }
}

@_cdecl("openmasu_ios_prepare_app_store_purchase")
public func openmasuIOSPrepareAppStorePurchase(
  _ productId: UnsafePointer<CChar>?,
  _ purchaseRequestId: UnsafePointer<CChar>?,
  _ revenueMeasurementConsent: Bool,
  _ requestId: Int64,
  _ callbackValue: OpenMasuCStringCallback?
) {
  guard let sdk = BridgeState.get() else {
    callback(callbackValue, requestId: requestId, value: "state=not_submitted&error=not_initialized")
    return
  }
  guard let productId, let purchaseRequestId else {
    callback(callbackValue, requestId: requestId, value: AppStorePurchaseBridge.failure(OpenMasuError.invalidAttributes))
    return
  }
  let product = String(cString: productId), purchaseRequest = String(cString: purchaseRequestId)
  Task {
    let result = await AppStorePurchaseBridge.prepare(
      sdk: sdk, productId: product, purchaseRequestId: purchaseRequest, consent: revenueMeasurementConsent
    )
    callback(callbackValue, requestId: requestId, value: result)
  }
}

@_cdecl("openmasu_ios_submit_app_store_purchase")
public func openmasuIOSSubmitAppStorePurchase(
  _ encodedPreparation: UnsafePointer<CChar>?,
  _ signedTransaction: UnsafePointer<CChar>?,
  _ revenueMeasurementConsent: Bool,
  _ requestId: Int64,
  _ callbackValue: OpenMasuCStringCallback?
) {
  guard let sdk = BridgeState.get() else {
    callback(callbackValue, requestId: requestId, value: "state=not_submitted&error=not_initialized")
    return
  }
  guard let encodedPreparation, let signedTransaction else {
    callback(callbackValue, requestId: requestId, value: AppStorePurchaseBridge.failure(OpenMasuError.invalidAttributes))
    return
  }
  let prepared = String(cString: encodedPreparation), transaction = String(cString: signedTransaction)
  Task {
    let result = await AppStorePurchaseBridge.submit(
      sdk: sdk, encodedPreparation: prepared, signedTransaction: transaction, consent: revenueMeasurementConsent
    )
    callback(callbackValue, requestId: requestId, value: result)
  }
}

@_cdecl("openmasu_ios_update_consent")
public func openmasuIOSUpdateConsent(
  _ state: UnsafePointer<CChar>?,
  _ policyVersion: UnsafePointer<CChar>?,
  _ requestId: Int64,
  _ callbackValue: OpenMasuCStringCallback?
) {
  guard let sdk = BridgeState.get() else {
    callback(callbackValue, requestId: requestId, value: "state=not_submitted&error=not_initialized")
    return
  }
  guard let state, let policyVersion else {
    callback(callbackValue, requestId: requestId, value: "state=not_submitted&error=invalid_consent")
    return
  }
  let stateValue = String(cString: state), policy = String(cString: policyVersion)
  guard ["granted", "denied", "withdrawn", "not_required", "unknown"].contains(stateValue),
        policy.range(of: "^[A-Za-z0-9._:-]{1,128}$", options: .regularExpression) != nil else {
    callback(callbackValue, requestId: requestId, value: "state=not_submitted&error=invalid_consent")
    return
  }
  Task {
    do {
      try await sdk.updateConsent(state: stateValue, policyVersion: policy)
      callback(callbackValue, requestId: requestId, value: "state=updated")
    } catch {
      callback(callbackValue, requestId: requestId, value: "state=not_submitted&error=consent_update_failed")
    }
  }
}

@_cdecl("openmasu_ios_track_refund")
public func openmasuIOSTrackRefund(
  _ transactionId: UnsafePointer<CChar>?,
  _ originalTransactionId: UnsafePointer<CChar>?,
  _ amountUnscaled: UnsafePointer<CChar>?,
  _ amountScale: Int32,
  _ currency: UnsafePointer<CChar>?,
  _ requestId: Int64,
  _ callbackValue: OpenMasuCStringCallback?
) {
  guard let sdk = BridgeState.get(), let transactionId, let originalTransactionId,
        let amountUnscaled, let currency else {
    callback(callbackValue, requestId: requestId, value: "error:not_initialized_or_invalid_refund")
    return
  }
  let transactionIdValue = String(cString: transactionId)
  let originalTransactionIdValue = String(cString: originalTransactionId)
  let amountUnscaledValue = String(cString: amountUnscaled)
  let currencyValue = String(cString: currency)
  Task {
    do {
      try await sdk.trackRefund(
        transactionId: transactionIdValue,
        originalTransactionId: originalTransactionIdValue,
        amountUnscaled: amountUnscaledValue,
        amountScale: Int(amountScale),
        currency: currencyValue
      )
      callback(callbackValue, requestId: requestId, value: "ok")
    } catch {
      callback(callbackValue, requestId: requestId, value: "error:refund_failed")
    }
  }
}

@_cdecl("openmasu_ios_track_max_revenue")
public func openmasuIOSTrackMaxRevenue(
  _ revenue: Double,
  _ precision: UnsafePointer<CChar>?,
  _ networkName: UnsafePointer<CChar>?,
  _ adUnitId: UnsafePointer<CChar>?,
  _ format: UnsafePointer<CChar>?,
  _ placement: UnsafePointer<CChar>?,
  _ networkPlacement: UnsafePointer<CChar>?,
  _ requestId: Int64,
  _ callbackValue: OpenMasuCStringCallback?
) {
  guard let sdk = BridgeState.get(), let precision, let networkName, let adUnitId, let format else {
    callback(callbackValue, requestId: requestId, value: "error:not_initialized_or_invalid_revenue")
    return
  }
  let observation = MaxRevenueObservation(
    revenue: revenue,
    precision: String(cString: precision),
    networkName: String(cString: networkName),
    adUnitId: String(cString: adUnitId),
    format: String(cString: format),
    placement: placement.map(String.init(cString:)),
    networkPlacement: networkPlacement.map(String.init(cString:))
  )
  Task {
    do {
      let installationId = try await sdk.installationIdForMeasurement()
      let mapper = MaxRevenueMapper(installationId: { installationId })
      let accepted = try await OpenMasuMaxAdapter(sdk: sdk, mapper: mapper).didPayRevenue(observation)
      callback(callbackValue, requestId: requestId, value: accepted ? "ok" : "error:revenue_rejected")
    } catch {
      callback(callbackValue, requestId: requestId, value: "error:revenue_failed")
    }
  }
}

@_cdecl("openmasu_ios_start_session")
public func openmasuIOSStartSession(
  _ requestId: Int64,
  _ callbackValue: OpenMasuCStringCallback?
) {
  guard let sdk = BridgeState.get() else {
    callback(callbackValue, requestId: requestId, value: "error:not_initialized")
    return
  }
  Task {
    do { try await sdk.startSession(); callback(callbackValue, requestId: requestId, value: "ok") }
    catch { callback(callbackValue, requestId: requestId, value: "error:session_failed") }
  }
}

@_cdecl("openmasu_ios_set_collection_enabled")
public func openmasuIOSSetCollectionEnabled(_ enabled: Bool) {
  guard let sdk = BridgeState.get() else { return }
  Task { try? await sdk.setCollectionEnabled(enabled) }
}

@_cdecl("openmasu_ios_queue_health")
public func openmasuIOSQueueHealth(
  _ requestId: Int64,
  _ callbackValue: OpenMasuCStringCallback?
) {
  guard let sdk = BridgeState.get() else {
    callback(callbackValue, requestId: requestId, value: "error:not_initialized")
    return
  }
  Task {
    do {
      let health = try await sdk.queueHealth()
      callback(
        callbackValue,
        requestId: requestId,
        value: "pending_count=\(health.pendingCount)&logical_bytes=\(health.logicalBytes)&evicted_total=\(health.evictedTotal)&rejected_total=\(health.rejectedTotal)"
      )
    } catch {
      callback(callbackValue, requestId: requestId, value: "error:queue_health_failed")
    }
  }
}

@_cdecl("openmasu_ios_reset_installation")
public func openmasuIOSResetInstallation(
  _ requestId: Int64,
  _ callbackValue: OpenMasuCStringCallback?
) {
  guard let sdk = BridgeState.get() else {
    callback(callbackValue, requestId: requestId, value: "error:not_initialized")
    return
  }
  Task {
    do { try await sdk.resetInstallationId(); callback(callbackValue, requestId: requestId, value: "ok") }
    catch { callback(callbackValue, requestId: requestId, value: "error:reset_failed") }
  }
}

@_cdecl("openmasu_ios_ping_from_background")
public func openmasuIOSPingFromBackground(
  _ value: UnsafePointer<CChar>?,
  _ requestId: Int64,
  _ callbackValue: OpenMasuCStringCallback?
) {
  let copied = value.map(String.init(cString:)) ?? ""
  DispatchQueue.global(qos: .utility).async {
    callback(callbackValue, requestId: requestId, value: copied)
  }
}
