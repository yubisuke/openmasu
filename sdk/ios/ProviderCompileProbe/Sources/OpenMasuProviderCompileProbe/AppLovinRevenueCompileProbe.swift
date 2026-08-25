import AppLovinSDK
import Foundation
import OpenMasuMax

/// This target is a compile-only proof. The shipping OpenMasuMax product has no
/// AppLovin runtime dependency; an application that already embeds MAX can use
/// this delegate to feed the audited mapper.
public final class AppLovinRevenueCompileProbe: NSObject, MAAdRevenueDelegate {
  private let adapter: OpenMasuMaxAdapter

  public init(adapter: OpenMasuMaxAdapter) { self.adapter = adapter }

  public func register(
    interstitial: MAInterstitialAd,
    rewarded: MARewardedAd,
    adView: MAAdView
  ) {
    interstitial.revenueDelegate = self
    rewarded.revenueDelegate = self
    adView.revenueDelegate = self
  }

  public func didPayRevenue(for ad: MAAd) {
    let observation = MaxRevenueObservation(
      revenue: ad.revenue,
      precision: ad.revenuePrecision,
      networkName: ad.networkName,
      adUnitId: ad.adUnitIdentifier,
      format: ad.format.label,
      placement: ad.placement,
      networkPlacement: ad.networkPlacement
    )
    Task { _ = try? await adapter.didPayRevenue(observation) }
  }
}
