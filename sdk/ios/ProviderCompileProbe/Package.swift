// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "OpenMmpProviderCompileProbe",
  platforms: [.iOS(.v16)],
  products: [.library(name: "OpenMmpProviderCompileProbe", targets: ["OpenMmpProviderCompileProbe"])],
  dependencies: [
    .package(name: "OpenMmpIOS", path: ".."),
    .package(
      url: "https://github.com/AppLovin/AppLovin-MAX-Swift-Package.git",
      exact: "13.6.4"
    ),
  ],
  targets: [
    .target(
      name: "OpenMmpProviderCompileProbe",
      dependencies: [
        .product(name: "OpenMmpMax", package: "OpenMmpIOS"),
        .product(name: "AppLovinSDK", package: "applovin-max-swift-package"),
      ]
    ),
  ]
)
