import Foundation
#if canImport(OpenMasuCore)
import OpenMasuCore
#endif
#if canImport(AdServices)
import AdServices
#endif

public struct SystemAdServicesTokenProvider: AdServicesTokenProviding {
  public init() {}

  public func attributionToken() throws -> String? {
    #if canImport(AdServices)
    if #available(iOS 14.3, macOS 11.1, *) { return try AAAttribution.attributionToken() }
    #endif
    return nil
  }
}
