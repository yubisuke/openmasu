import Foundation
#if canImport(OpenMasuCore)
import OpenMasuCore
#endif

private func meaningMatches(_ value: String, _ pattern: String) -> Bool {
  value.range(of: pattern, options: .regularExpression) == value.startIndex..<value.endIndex
}

/// Opt-in, install-only meaning profile. Array order defines event bits; money is exact minor units.
public struct ConversionMeaningSchema: Codable, Sendable {
  public struct Revenue: Codable, Sendable {
    public let event_key: String
    public let currency: String
    public let amount_scale: Int
    public let thresholds: [String]
  }
  public struct Coarse: Codable, Sendable {
    public let medium_from: Int
    public let high_from: Int
  }
  public let profile: String
  public let schema_version: String
  public let effective_from: String
  public let effective_to: String
  public let event_keys: [String]
  public let revenue: Revenue
  public let coarse: Coarse
  public let lock_at_maximum: Bool

  public static func load(data: Data, registeredVersion: String, registeredDigest: String) throws -> ConversionMeaningSchema {
    let root = try JSONSerialization.jsonObject(with: data)
    func keys(_ object: Any?, _ expected: [String]) -> Bool {
      guard let object = object as? [String: Any] else { return false }
      return Set(object.keys) == Set(expected)
    }
    guard let object = root as? [String: Any],
      keys(root, ["profile", "schema_version", "effective_from", "effective_to", "event_keys", "revenue", "coarse", "lock_at_maximum"]),
      keys(object["revenue"], ["event_key", "currency", "amount_scale", "thresholds"]),
      keys(object["coarse"], ["medium_from", "high_from"])
    else { throw OpenMasuError.conversionSchema("conversion_meaning_invalid") }
    let value = try JSONDecoder().decode(Self.self, from: data)
    try value.validate()
    // Only ASCII keys/values and bounded integers exist in this profile. Sorted JSON equals server canonical JSON.
    let canonical = try JSONSerialization.data(withJSONObject: root, options: [.sortedKeys, .withoutEscapingSlashes])
    guard value.schema_version == registeredVersion, ConversionSchema.digest(data: canonical) == registeredDigest else {
      throw OpenMasuError.conversionSchema("conversion_schema_digest_mismatch")
    }
    return value
  }

  public var digest: String {
    get throws {
      try validate()
      let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(self))
      return ConversionSchema.digest(data: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]))
    }
  }
  private func matches(_ value: String, _ pattern: String) -> Bool { meaningMatches(value, pattern) }
  private func validate() throws {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let dates = [effective_from, effective_to]
    guard profile == "event_revenue_v1", matches(schema_version, "^[0-9]+\\.[0-9]+\\.[0-9]+$"),
      dates.allSatisfy({ matches($0, "^[0-9]{4}-[0-9]{2}-[0-9]{2}T00:00:00\\.000Z$") && formatter.date(from: $0).map { formatter.string(from: $0) } == $0 }),
      effective_from < effective_to, (1...3).contains(event_keys.count), Set(event_keys).count == event_keys.count,
      event_keys.allSatisfy({ matches($0, "^[a-z][a-z0-9_]{1,47}$") }), event_keys.contains(revenue.event_key),
      matches(revenue.currency, "^[A-Z]{3}$"), (0...6).contains(revenue.amount_scale), (2...8).contains(revenue.thresholds.count),
      revenue.thresholds.first == "0", revenue.thresholds.allSatisfy({ matches($0, "^(0|[1-9][0-9]{0,14})$") && Int64($0) != nil }),
      zip(revenue.thresholds, revenue.thresholds.dropFirst()).allSatisfy({ Int64($0.0)! < Int64($0.1)! }),
      maximumFine < 64, coarse.medium_from > 0, coarse.high_from > coarse.medium_from, coarse.high_from <= maximumFine
    else { throw OpenMasuError.conversionSchema("conversion_meaning_invalid") }
  }
  public var maximumFine: Int { (1 << event_keys.count) * revenue.thresholds.count - 1 }

  public func evaluate(eventMask: Int, revenueUnscaled: Int64) throws -> ConversionUpdate {
    try validate()
    guard (0..<(1 << event_keys.count)).contains(eventMask), revenueUnscaled >= 0 else {
      throw OpenMasuError.conversionSchema("conversion_signal_invalid")
    }
    let bucket = revenue.thresholds.filter { Int64($0)! <= revenueUnscaled }.count - 1
    let fine = eventMask + (1 << event_keys.count) * bucket
    return try ConversionUpdate(fineValue: fine,
      coarseValue: fine >= coarse.high_from ? .high : fine >= coarse.medium_from ? .medium : .low,
      lockPostback: lock_at_maximum && fine == maximumFine, conversionTypes: [.install])
  }
}

/// Host declares a local install window (0/1/2); this does not discover Apple's hidden OS window.
/// One SDK instance owns storage. No tag/reengagement, enrollment, upload or identifier creation here.
public actor MeaningConversionController {
  private struct Window: Codable {
    var events: [String: String] = [:]
    var mask: Int = 0
    var revenue: Int64 = 0
    var submitted: ConversionUpdate?
  }
  private struct State: Codable {
    let digest: String
    var windows: [String: Window] = [:]
  }
  private let schema: ConversionMeaningSchema
  private let sdk: OpenMasuSDK
  private let updater: any AppleConversionUpdating

  public init(schema: ConversionMeaningSchema, sdk: OpenMasuSDK, updater: any AppleConversionUpdating) {
    self.schema = schema; self.sdk = sdk; self.updater = updater
  }

  @discardableResult
  public func record(eventID: String, eventKey: String, revenueUnscaled: String? = nil,
                     windowSequence: Int, consentGranted: Bool, now: Date = Date()) async throws -> ConversionUpdate {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let timestamp = formatter.string(from: now)
    guard schema.effective_from <= timestamp, timestamp < schema.effective_to, (0...2).contains(windowSequence),
      meaningMatches(eventID, "^[A-Za-z0-9._:-]{1,128}$"),
      let index = schema.event_keys.firstIndex(of: eventKey)
    else { throw OpenMasuError.conversionSchema("conversion_signal_invalid") }
    let amount = revenueUnscaled ?? "0"
    guard meaningMatches(amount, "^(0|[1-9][0-9]{0,14})$"),
      let revenue = Int64(amount), revenueUnscaled == nil || eventKey == schema.revenue.event_key
    else { throw OpenMasuError.conversionSchema("conversion_revenue_invalid") }
    let digest = try schema.digest
    let lease = try await sdk.beginAppleConversionState(consentGranted: consentGranted, schemaVersion: schema.schema_version, schemaDigest: digest)
    do {
      var state = try lease.state.map { try JSONDecoder().decode(State.self, from: Data($0.utf8)) } ?? State(digest: digest)
      guard state.digest == digest else { throw OpenMasuError.conversionSchema("conversion_active_schema_changed") }
      let key = String(windowSequence)
      var window = state.windows[key] ?? Window()
      let id = ConversionSchema.digest(data: Data(eventID.utf8))
      let fingerprint = ConversionSchema.digest(data: Data("\(eventKey):\(amount)".utf8))
      if let previous = window.events[id], previous != fingerprint { throw OpenMasuError.conversionSchema("conversion_event_conflict") }
      if window.events[id] != nil || window.submitted?.lockPostback == true {
        guard let value = window.submitted else { throw OpenMasuError.conversionSchema("conversion_state_invalid") }
        await sdk.cancelAppleConversionState(lease)
        return value
      }
      guard window.events.count < 512 else { throw OpenMasuError.conversionSchema("conversion_state_limit") }
      window.events[id] = fingerprint
      window.mask |= 1 << index
      // Saturating at the last boundary preserves the exact bucket without unbounded revenue retention.
      window.revenue = min(Int64(schema.revenue.thresholds.last!)!, window.revenue + revenue)
      let update = try schema.evaluate(eventMask: window.mask, revenueUnscaled: window.revenue)
      if update != window.submitted { try await updater.update(update) }
      window.submitted = update
      state.windows[key] = window
      let encoded = String(decoding: try JSONEncoder().encode(state), as: UTF8.self)
      try await sdk.finishAppleConversionState(lease, state: encoded)
      return update
    } catch {
      await sdk.cancelAppleConversionState(lease)
      throw error
    }
  }
}
