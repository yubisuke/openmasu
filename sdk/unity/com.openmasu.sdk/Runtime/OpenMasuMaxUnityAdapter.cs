#if OPENMASU_APPLOVIN_MAX
using UnityEngine;

namespace OpenMasu.Unity
{
    public static class OpenMasuMaxUnityAdapter
    {
        public static void Subscribe()
        {
            MaxSdkCallbacks.Interstitial.OnAdRevenuePaidEvent += OnInterstitialRevenuePaid;
            MaxSdkCallbacks.Rewarded.OnAdRevenuePaidEvent += OnRewardedRevenuePaid;
            MaxSdkCallbacks.Banner.OnAdRevenuePaidEvent += OnBannerRevenuePaid;
            MaxSdkCallbacks.MRec.OnAdRevenuePaidEvent += OnMRecRevenuePaid;
        }

        public static void Unsubscribe()
        {
            MaxSdkCallbacks.Interstitial.OnAdRevenuePaidEvent -= OnInterstitialRevenuePaid;
            MaxSdkCallbacks.Rewarded.OnAdRevenuePaidEvent -= OnRewardedRevenuePaid;
            MaxSdkCallbacks.Banner.OnAdRevenuePaidEvent -= OnBannerRevenuePaid;
            MaxSdkCallbacks.MRec.OnAdRevenuePaidEvent -= OnMRecRevenuePaid;
        }

        private static void OnInterstitialRevenuePaid(string adUnitId, MaxSdk.AdInfo adInfo) =>
            OnAdRevenuePaid(adUnitId, adInfo, "interstitial");

        private static void OnRewardedRevenuePaid(string adUnitId, MaxSdk.AdInfo adInfo) =>
            OnAdRevenuePaid(adUnitId, adInfo, "rewarded");

        private static void OnBannerRevenuePaid(string adUnitId, MaxSdk.AdInfo adInfo) =>
            OnAdRevenuePaid(adUnitId, adInfo, "banner");

        private static void OnMRecRevenuePaid(string adUnitId, MaxSdk.AdInfo adInfo) =>
            OnAdRevenuePaid(adUnitId, adInfo, "mrec");

        private static void OnAdRevenuePaid(string adUnitId, MaxSdk.AdInfo adInfo, string format)
        {
#if UNITY_IOS && !UNITY_EDITOR
            OpenMasuiOSPlatform.TrackMaxRevenue(
                adInfo.Revenue,
                adInfo.RevenuePrecision,
                adInfo.NetworkName,
                adInfo.AdUnitIdentifier,
                format,
                adInfo.Placement,
                adInfo.NetworkPlacement,
                _ => { });
#elif UNITY_ANDROID && !UNITY_EDITOR
            using (var bridge = new AndroidJavaClass("dev.openmasu.unity.OpenMasuUnityBridge"))
            {
                bridge.CallStatic<bool>(
                    "trackMaxRevenue",
                    adInfo.Revenue,
                    adInfo.RevenuePrecision,
                    adInfo.NetworkName,
                    adInfo.AdUnitIdentifier,
                    adInfo.Placement,
                    adInfo.NetworkPlacement);
            }
#endif
        }
    }
}
#endif
