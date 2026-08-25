// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "OpenMasuIOS",
  platforms: [.iOS(.v16), .macOS(.v13)],
  products: [
    .library(name: "OpenMasuCore", targets: ["OpenMasuCore"]),
    .library(name: "OpenMasuAppleAds", targets: ["OpenMasuAppleAds"]),
    .library(name: "OpenMasuApplePostback", targets: ["OpenMasuApplePostback"]),
    .library(name: "OpenMasuMax", targets: ["OpenMasuMax"]),
    .library(name: "OpenMasuObjC", targets: ["OpenMasuObjC"]),
    .library(name: "OpenMasuSample", targets: ["OpenMasuSample"]),
  ],
  targets: [
    .target(
      name: "OpenMasuCore",
      resources: [.process("PrivacyInfo.xcprivacy")],
      linkerSettings: [.linkedLibrary("sqlite3")]
    ),
    .target(name: "OpenMasuAppleAds", dependencies: ["OpenMasuCore"]),
    .target(
      name: "OpenMasuApplePostback",
      dependencies: ["OpenMasuCore"],
      resources: [.process("Resources")]
    ),
    .target(name: "OpenMasuMax", dependencies: ["OpenMasuCore"]),
    .target(
      name: "OpenMasuObjC",
      dependencies: ["OpenMasuCore", "OpenMasuAppleAds", "OpenMasuApplePostback", "OpenMasuMax"]
    ),
    .target(
      name: "OpenMasuSample",
      dependencies: ["OpenMasuCore", "OpenMasuAppleAds", "OpenMasuApplePostback"],
      path: "Sample",
      exclude: ["README.md"]
    ),
    .testTarget(name: "OpenMasuCoreTests", dependencies: ["OpenMasuCore"]),
    .testTarget(name: "OpenMasuApplePostbackTests", dependencies: ["OpenMasuApplePostback", "OpenMasuCore"]),
    .testTarget(name: "OpenMasuMaxTests", dependencies: ["OpenMasuMax"]),
  ],
  swiftLanguageVersions: [.v5]
)
