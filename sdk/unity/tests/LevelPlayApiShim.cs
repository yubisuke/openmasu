// Test-only shape of the documented LevelPlay 9.5+ ILR surface.
// This is not the provider SDK and is never included in the UPM package.
using System;

namespace Unity.Services.LevelPlay
{
    public sealed class LevelPlayImpressionData
    {
        public string AuctionId { get; set; }
        public double? Revenue { get; set; }
        public string Precision { get; set; }
        public string AdNetwork { get; set; }
        public string AllData => throw new InvalidOperationException("The binding must never read raw impression data");
    }

    public abstract class LevelPlayAdShim
    {
        private Action<LevelPlayImpressionData> callback;
        public int Subscribers { get; private set; }
        public event Action<LevelPlayImpressionData> OnAdImpressionDataReady
        {
            add { callback += value; Subscribers++; }
            remove { callback -= value; Subscribers--; }
        }
        public void Raise(LevelPlayImpressionData value) => callback?.Invoke(value);
        public Action Pending(LevelPlayImpressionData value) { var captured = callback; return () => captured?.Invoke(value); }
    }
    public sealed class LevelPlayRewardedAd : LevelPlayAdShim { }
    public sealed class LevelPlayInterstitialAd : LevelPlayAdShim { }
    public sealed class LevelPlayBannerAd : LevelPlayAdShim { }
}
