import Foundation
#if canImport(OpenMasuCore)
import OpenMasuCore
#endif

public struct MaxRevenueObservation: Sendable {
  public let revenue: Double
  public let precision: String
  public let networkName: String
  public let adUnitId: String
  public let format: String
  public let placement: String?
  public let networkPlacement: String?

  public init(
    revenue: Double,
    precision: String,
    networkName: String,
    adUnitId: String,
    format: String,
    placement: String? = nil,
    networkPlacement: String? = nil
  ) {
    self.revenue = revenue
    self.precision = precision
    self.networkName = networkName
    self.adUnitId = adUnitId
    self.format = format
    self.placement = placement
    self.networkPlacement = networkPlacement
  }
}

public final class MaxRevenueMapper: @unchecked Sendable {
  private let installationId: @Sendable () throws -> String
  private let impressionId: @Sendable () -> String
  private let lock = NSLock()
  private var rejected = 0

  public init(
    installationId: @escaping @Sendable () throws -> String,
    impressionId: (@Sendable () -> String)? = nil
  ) {
    self.installationId = installationId
    self.impressionId = impressionId ?? { "impression:\(UuidV7.generate().uuidString.lowercased())" }
  }

  public var errorCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return rejected
  }

  public func map(_ observation: MaxRevenueObservation) throws -> [String: Any]? {
    guard observation.revenue.isFinite, observation.revenue >= 0,
          ["publisher_defined", "exact", "estimated", "undefined"].contains(observation.precision),
          !observation.networkName.isEmpty, !observation.adUnitId.isEmpty
    else {
      lock.lock(); rejected += 1; lock.unlock()
      return nil
    }
    guard let decimalRevenue = Decimal(string: String(observation.revenue), locale: Locale(identifier: "en_US_POSIX")) else {
      lock.lock(); rejected += 1; lock.unlock()
      return nil
    }
    var value = decimalRevenue * Decimal(1_000_000)
    var rounded = Decimal()
    NSDecimalRound(&rounded, &value, 0, .bankers)
    var extensions: [String: Any] = ["ad_format": observation.format]
    if let placement = observation.placement { extensions["placement"] = placement }
    if let networkPlacement = observation.networkPlacement { extensions["network_placement"] = networkPlacement }
    return [
      "event_name": "ad_revenue",
      "subject_scope": "installation_level",
      "installation_id": try installationId(),
      "impression_id": impressionId(),
      "ad_unit_id": observation.adUnitId,
      "ad_network": observation.networkName,
      "mediation_provider": "applovin-max",
      "amount_unscaled": NSDecimalNumber(decimal: rounded).stringValue,
      "amount_scale": 6,
      "currency": "USD",
      "currency_source": "reported",
      "revenue_source": "client_estimated",
      "revenue_precision": observation.precision,
      "extensions": extensions,
    ]
  }
}

public struct OpenMasuMaxAdapter: Sendable {
  private let sdk: OpenMasuSDK
  private let mapper: MaxRevenueMapper

  public init(sdk: OpenMasuSDK, mapper: MaxRevenueMapper) {
    self.sdk = sdk
    self.mapper = mapper
  }

  @discardableResult
  public func didPayRevenue(_ observation: MaxRevenueObservation) async throws -> Bool {
    guard let payload = try mapper.map(observation) else { return false }
    guard let eventId = payload["impression_id"] as? String else { return false }
    try await sdk.enqueueAdRevenue(payload: payload, eventId: eventId)
    return true
  }
}

private enum UuidV7 {
  static func generate(now: Date = Date()) -> UUID {
    let milliseconds = UInt64(max(0, now.timeIntervalSince1970 * 1_000))
    var bytes = (0..<16).map { _ in UInt8.random(in: 0...255) }
    for index in 0..<6 { bytes[index] = UInt8((milliseconds >> UInt64((5 - index) * 8)) & 0xff) }
    bytes[6] = (bytes[6] & 0x0f) | 0x70
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    return UUID(uuid: (
      bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
      bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    ))
  }
}
