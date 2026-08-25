// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "OpenMmpIOS",
  platforms: [.iOS(.v16), .macOS(.v13)],
  products: [
    .library(name: "OpenMmpCore", targets: ["OpenMmpCore"]),
    .library(name: "OpenMmpAppleAds", targets: ["OpenMmpAppleAds"]),
    .library(name: "OpenMmpApplePostback", targets: ["OpenMmpApplePostback"]),
    .library(name: "OpenMmpMax", targets: ["OpenMmpMax"]),
    .library(name: "OpenMmpObjC", targets: ["OpenMmpObjC"]),
    .library(name: "OpenMmpSample", targets: ["OpenMmpSample"]),
  ],
  targets: [
    .target(
      name: "OpenMmpCore",
      resources: [.process("PrivacyInfo.xcprivacy")],
      linkerSettings: [.linkedLibrary("sqlite3")]
    ),
    .target(name: "OpenMmpAppleAds", dependencies: ["OpenMmpCore"]),
    .target(
      name: "OpenMmpApplePostback",
      dependencies: ["OpenMmpCore"],
      resources: [.process("Resources")]
    ),
    .target(name: "OpenMmpMax", dependencies: ["OpenMmpCore"]),
    .target(
      name: "OpenMmpObjC",
      dependencies: ["OpenMmpCore", "OpenMmpAppleAds", "OpenMmpApplePostback", "OpenMmpMax"]
    ),
    .target(
      name: "OpenMmpSample",
      dependencies: ["OpenMmpCore", "OpenMmpAppleAds", "OpenMmpApplePostback"],
      path: "Sample",
      exclude: ["README.md"]
    ),
    .testTarget(name: "OpenMmpCoreTests", dependencies: ["OpenMmpCore"]),
    .testTarget(name: "OpenMmpApplePostbackTests", dependencies: ["OpenMmpApplePostback", "OpenMmpCore"]),
    .testTarget(name: "OpenMmpMaxTests", dependencies: ["OpenMmpMax"]),
  ],
  swiftLanguageVersions: [.v5]
)
