using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Threading;
using OpenMasu.Unity;
using Unity.Services.LevelPlay;

namespace OpenMasu.Unity.Integrations
{
    // Optional imported sample, not a dependency of OpenMasu.Runtime.
    // Requires the LevelPlay 9.5+ per-ad ILR API in the host project.
    public sealed class OpenMasuLevelPlayAdapter : IDisposable
    {
        private readonly OpenMasuClient client;
        private readonly object gate = new object();
        private readonly Dictionary<object, Binding> bindings = new Dictionary<object, Binding>(new IdentityComparer());
        private bool disposed;
        private long rejected;

        public OpenMasuLevelPlayAdapter(OpenMasuClient client) => this.client = client ?? throw new ArgumentNullException(nameof(client));
        public long RejectedCount => Interlocked.Read(ref rejected);

        public void Subscribe(LevelPlayRewardedAd ad, string adUnitId) => Bind(ad, adUnitId, "rewarded",
            handler => ad.OnAdImpressionDataReady += handler, handler => ad.OnAdImpressionDataReady -= handler);
        public void Subscribe(LevelPlayInterstitialAd ad, string adUnitId) => Bind(ad, adUnitId, "interstitial",
            handler => ad.OnAdImpressionDataReady += handler, handler => ad.OnAdImpressionDataReady -= handler);
        public void Subscribe(LevelPlayBannerAd ad, string adUnitId) => Bind(ad, adUnitId, "banner",
            handler => ad.OnAdImpressionDataReady += handler, handler => ad.OnAdImpressionDataReady -= handler);

        public void Unsubscribe(object ad)
        {
            if (ad == null) return;
            lock (gate)
            {
                if (!bindings.TryGetValue(ad, out var binding)) return;
                binding.Active = false;
                binding.Remove();
                bindings.Remove(ad);
            }
        }

        private void Bind(object ad, string adUnitId, string format,
            Action<Action<LevelPlayImpressionData>> add, Action<Action<LevelPlayImpressionData>> remove)
        {
            if (ad == null) throw new ArgumentNullException(nameof(ad));
            if (string.IsNullOrWhiteSpace(adUnitId) || adUnitId.Length > 128) throw new ArgumentException("levelplay_ad_unit_invalid", nameof(adUnitId));
            lock (gate)
            {
                if (disposed) throw new ObjectDisposedException(nameof(OpenMasuLevelPlayAdapter));
                if (bindings.TryGetValue(ad, out var existing))
                {
                    if (existing.AdUnitId != adUnitId || existing.Format != format) throw new ArgumentException("levelplay_subscription_conflict");
                    return;
                }
                if (bindings.Count >= 64) throw new InvalidOperationException("levelplay_subscription_limit");
                var binding = new Binding { Active = true, AdUnitId = adUnitId, Format = format };
                Action<LevelPlayImpressionData> handler = data => Receive(binding, data);
                binding.Remove = () => remove(handler);
                bindings.Add(ad, binding);
                try { add(handler); }
                catch { binding.Active = false; bindings.Remove(ad); throw; }
            }
        }

        private void Receive(Binding binding, LevelPlayImpressionData data)
        {
            lock (gate)
            {
                if (disposed || !binding.Active) return;
                // Never read AllData or call Unity/native APIs on the provider callback thread.
                if (data == null || !OpenMasuAdRevenueEvent.TryCreateUsdImpression("unity-levelplay", data.AuctionId,
                    data.Revenue, Precision(data.Precision), data.AdNetwork, binding.AdUnitId, binding.Format, out var value)
                    || !client.TryTrackAdRevenue(value)) Interlocked.Increment(ref rejected);
            }
        }

        private static OpenMasuRevenuePrecision Precision(string value)
        {
            switch ((value ?? string.Empty).Trim().ToUpperInvariant())
            {
                case "BID": return OpenMasuRevenuePrecision.Exact;
                case "RATE": return OpenMasuRevenuePrecision.PublisherDefined;
                case "CPM": return OpenMasuRevenuePrecision.Estimated;
                default: return OpenMasuRevenuePrecision.Undefined;
            }
        }

        public void Dispose()
        {
            lock (gate)
            {
                if (disposed) return;
                disposed = true;
                foreach (var binding in bindings.Values) { binding.Active = false; binding.Remove(); }
                bindings.Clear();
            }
        }

        private sealed class Binding
        {
            public bool Active;
            public string AdUnitId, Format;
            public Action Remove;
        }
        private sealed class IdentityComparer : IEqualityComparer<object>
        {
            public new bool Equals(object left, object right) => ReferenceEquals(left, right);
            public int GetHashCode(object value) => RuntimeHelpers.GetHashCode(value);
        }
    }
}
