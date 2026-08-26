import Foundation
#if canImport(OpenMasuAppleAds)
import OpenMasuAppleAds
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

  static func set(_ value: OpenMasuSDK) {
    lock.lock(); sdk = value; lock.unlock()
  }

  static func get() -> OpenMasuSDK? {
    lock.lock(); defer { lock.unlock() }
    return sdk
  }
}

private func callback(_ callback: OpenMasuCStringCallback?, requestId: Int64, value: String) {
  guard let callback else { return }
  DispatchQueue.main.async {
    value.withCString { callback(requestId, $0) }
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
    let configuration = OpenMasuConfiguration(
      endpoint: endpointURL,
      sdkKeyId: String(cString: sdkKeyId),
      sdkSecret: String(cString: sdkSecret),
      wrapperVersion: "unity-0.2.0-rc.2",
      deepLinkHosts: Set(Bundle.main.object(forInfoDictionaryKey: "OpenMasuLinkHosts") as? [String] ?? []),
      deepLinkSchemes: Set(Bundle.main.object(forInfoDictionaryKey: "OpenMasuLinkSchemes") as? [String] ?? [])
    )
    let sdk = try OpenMasuSDK(
      configuration: configuration,
      tokenProvider: SystemAdServicesTokenProvider()
    )
    BridgeState.set(sdk)
    Task {
      do { try await sdk.initialize(); callback(callbackValue, requestId: requestId, value: "ok") }
      catch { callback(callbackValue, requestId: requestId, value: "error:initialize_failed") }
    }
  } catch {
    callback(callbackValue, requestId: requestId, value: "error:storage_failed")
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
