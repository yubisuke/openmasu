import Foundation

public protocol AdServicesTokenProviding: Sendable {
  func attributionToken() throws -> String?
}

public struct DisabledAdServicesTokenProvider: AdServicesTokenProviding {
  public init() {}
  public func attributionToken() throws -> String? { nil }
}
