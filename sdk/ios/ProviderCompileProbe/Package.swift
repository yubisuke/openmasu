// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "OpenMasuProviderCompileProbe",
  platforms: [.iOS(.v16)],
  products: [.library(name: "OpenMasuProviderCompileProbe", targets: ["OpenMasuProviderCompileProbe"])],
  dependencies: [
    .package(name: "OpenMasuIOS", path: ".."),
    .package(
      url: "https://github.com/AppLovin/AppLovin-MAX-Swift-Package.git",
      exact: "13.6.4"
    ),
  ],
  targets: [
    .target(
      name: "OpenMasuProviderCompileProbe",
      dependencies: [
        .product(name: "OpenMasuMax", package: "OpenMasuIOS"),
        .product(name: "AppLovinSDK", package: "applovin-max-swift-package"),
      ]
    ),
  ]
)
