import Foundation

public enum OpenMasuResources {
  public static var privacyManifestURL: URL? {
    #if SWIFT_PACKAGE
    Bundle.module.url(forResource: "PrivacyInfo", withExtension: "xcprivacy")
    #else
    Bundle.main.url(forResource: "PrivacyInfo", withExtension: "xcprivacy")
    #endif
  }
}
