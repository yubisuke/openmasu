// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "OpenMasuQueueCrashProbePackage",
  platforms: [.macOS(.v13)],
  dependencies: [.package(name: "OpenMasuIOS", path: "..")],
  targets: [
    .executableTarget(
      name: "OpenMasuQueueCrashProbe",
      dependencies: [.product(name: "OpenMasuCore", package: "OpenMasuIOS")]
    ),
  ]
)
