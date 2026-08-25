// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "OpenMmpQueueCrashProbePackage",
  platforms: [.macOS(.v13)],
  dependencies: [.package(name: "OpenMmpIOS", path: "..")],
  targets: [
    .executableTarget(
      name: "OpenMmpQueueCrashProbe",
      dependencies: [.product(name: "OpenMmpCore", package: "OpenMmpIOS")]
    ),
  ]
)
