import Foundation
#if canImport(OpenMmpAppleAds)
import OpenMmpAppleAds
#endif
#if canImport(OpenMmpCore)
import OpenMmpCore
#endif
#if canImport(OpenMmpMax)
import OpenMmpMax
#endif

public typealias OpenMmpCStringCallback = @convention(c) (Int64, UnsafePointer<CChar>?) -> Void

private enum BridgeState {
  static let lock = NSLock()
  static var sdk: OpenMmpSDK?

  static func set(_ value: OpenMmpSDK) {
    lock.lock(); sdk = value; lock.unlock()
  }

  static func get() -> OpenMmpSDK? {
    lock.lock(); defer { lock.unlock() }
    return sdk
  }
}

private func callback(_ callback: OpenMmpCStringCallback?, requestId: Int64, value: String) {
  guard let callback else { return }
  DispatchQueue.main.async {
    value.withCString { callback(requestId, $0) }
  }
}

@_cdecl("openmmp_ios_initialize")
public func openmmpIOSInitialize(
  _ endpoint: UnsafePointer<CChar>?,
  _ sdkKeyId: UnsafePointer<CChar>?,
  _ sdkSecret: UnsafePointer<CChar>?,
  _ requestId: Int64,
  _ callbackValue: OpenMmpCStringCallback?
) {
  guard let endpoint, let sdkKeyId, let sdkSecret,
        let endpointURL = URL(string: String(cString: endpoint))
  else { callback(callbackValue, requestId: requestId, value: "error:configuration_invalid"); return }
  do {
    let configuration = OpenMmpConfiguration(
      endpoint: endpointURL,
      sdkKeyId: String(cString: sdkKeyId),
      sdkSecret: String(cString: sdkSecret),
      wrapperVersion: "unity-0.1.0"
    )
    let sdk = try OpenMmpSDK(
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

@_cdecl("openmmp_ios_track_custom_event")
public func openmmpIOSTrackCustomEvent(
  _ eventKey: UnsafePointer<CChar>?,
  _ requestId: Int64,
  _ callbackValue: OpenMmpCStringCallback?
) {
  guard let eventKey, let sdk = BridgeState.get() else {
    callback(callbackValue, requestId: requestId, value: "error:not_initialized")
    return
  }
  Task {
    do { try await sdk.trackCustomEvent(String(cString: eventKey)); callback(callbackValue, requestId: requestId, value: "ok") }
    catch { callback(callbackValue, requestId: requestId, value: "error:track_failed") }
  }
}

@_cdecl("openmmp_ios_track_max_revenue")
public func openmmpIOSTrackMaxRevenue(
  _ revenue: Double,
  _ precision: UnsafePointer<CChar>?,
  _ networkName: UnsafePointer<CChar>?,
  _ adUnitId: UnsafePointer<CChar>?,
  _ format: UnsafePointer<CChar>?,
  _ placement: UnsafePointer<CChar>?,
  _ networkPlacement: UnsafePointer<CChar>?,
  _ requestId: Int64,
  _ callbackValue: OpenMmpCStringCallback?
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
      let accepted = try await OpenMmpMaxAdapter(sdk: sdk, mapper: mapper).didPayRevenue(observation)
      callback(callbackValue, requestId: requestId, value: accepted ? "ok" : "error:revenue_rejected")
    } catch {
      callback(callbackValue, requestId: requestId, value: "error:revenue_failed")
    }
  }
}

@_cdecl("openmmp_ios_start_session")
public func openmmpIOSStartSession(
  _ requestId: Int64,
  _ callbackValue: OpenMmpCStringCallback?
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

@_cdecl("openmmp_ios_set_collection_enabled")
public func openmmpIOSSetCollectionEnabled(_ enabled: Bool) {
  guard let sdk = BridgeState.get() else { return }
  Task { try? await sdk.setCollectionEnabled(enabled) }
}

@_cdecl("openmmp_ios_reset_installation")
public func openmmpIOSResetInstallation(
  _ requestId: Int64,
  _ callbackValue: OpenMmpCStringCallback?
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

@_cdecl("openmmp_ios_ping_from_background")
public func openmmpIOSPingFromBackground(
  _ value: UnsafePointer<CChar>?,
  _ requestId: Int64,
  _ callbackValue: OpenMmpCStringCallback?
) {
  let copied = value.map(String.init(cString:)) ?? ""
  DispatchQueue.global(qos: .utility).async {
    callback(callbackValue, requestId: requestId, value: copied)
  }
}
