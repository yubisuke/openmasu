using System;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace OpenMasu.Unity
{
    // Optional capability: existing IOpenMasuPlatform implementations remain compatible.
    public interface IOpenMasuAdRevenuePlatform
    {
        void TrackAdRevenue(OpenMasuAdRevenueEvent value);
    }

    public enum OpenMasuRevenuePrecision { Exact, Estimated, PublisherDefined, Undefined }

    public sealed class OpenMasuAdRevenueEvent
    {
        public string ImpressionId { get; private set; }
        public string AmountUnscaled { get; private set; }
        public string RevenuePrecision { get; private set; }
        public string AdNetwork { get; private set; }
        public string AdUnitId { get; private set; }
        public string MediationProvider { get; private set; }
        public string AdFormat { get; private set; }

        private OpenMasuAdRevenueEvent() { }

        // Amount is a reported USD observation, not verified revenue. Missing is not zero.
        public static bool TryCreateUsdImpression(string mediationProvider, string auctionId,
            double? revenue, OpenMasuRevenuePrecision precision, string adNetwork, string adUnitId,
            string adFormat, out OpenMasuAdRevenueEvent value)
        {
            value = null;
            if (!Identifier(mediationProvider) || !Identifier(adUnitId)
                || string.IsNullOrWhiteSpace(auctionId) || auctionId.Length > 512
                || string.IsNullOrWhiteSpace(adNetwork) || adNetwork.Length > 128
                || !revenue.HasValue || double.IsNaN(revenue.Value) || double.IsInfinity(revenue.Value)
                || revenue.Value < 0 || !Enum.IsDefined(typeof(OpenMasuRevenuePrecision), precision)
                || (adFormat != "rewarded" && adFormat != "interstitial" && adFormat != "banner" && adFormat != "unknown")) return false;
            if (!decimal.TryParse(revenue.Value.ToString("R", CultureInfo.InvariantCulture),
                NumberStyles.Float, CultureInfo.InvariantCulture, out var amount)) return false;
            string micros;
            try { micros = decimal.Round(checked(amount * 1_000_000m), 0, MidpointRounding.ToEven).ToString("0", CultureInfo.InvariantCulture); }
            catch (OverflowException) { return false; }
            var identity = new StringBuilder();
            foreach (var part in new[] { mediationProvider, auctionId, adUnitId, adFormat })
                identity.Append(part.Length.ToString(CultureInfo.InvariantCulture)).Append(':').Append(part);
            string digest;
            using (var hash = SHA256.Create()) digest = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(identity.ToString())))
                .Replace("-", string.Empty).ToLowerInvariant();
            value = new OpenMasuAdRevenueEvent {
                ImpressionId = "impression:" + digest,
                AmountUnscaled = micros,
                RevenuePrecision = precision == OpenMasuRevenuePrecision.PublisherDefined ? "publisher_defined" : precision.ToString().ToLowerInvariant(),
                AdNetwork = adNetwork,
                AdUnitId = adUnitId,
                MediationProvider = mediationProvider,
                AdFormat = adFormat,
            };
            return true;
        }

        private static bool Identifier(string value)
        {
            if (string.IsNullOrEmpty(value) || value.Length > 128) return false;
            foreach (var c in value)
                if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                    || c == '.' || c == '_' || c == ':' || c == '-')) return false;
            return true;
        }
    }

    public sealed partial class OpenMasuClient
    {
        private readonly object adRevenueGate = new object();
        private long adRevenueEpoch;
        private bool adRevenueCollectionEnabled;
        private bool adRevenueConsentEnabled;

        // True means bounded managed dispatch accepted, not native persistence or server receipt.
        // The host must enable collection and await a successful Granted/NotRequired update first.
        public bool TryTrackAdRevenue(OpenMasuAdRevenueEvent value)
        {
            if (value == null) throw new ArgumentNullException(nameof(value));
            lock (adRevenueGate)
            {
                if (disposed || !adRevenueCollectionEnabled || !adRevenueConsentEnabled
                    || !(platform is IOpenMasuAdRevenuePlatform target)) return false;
                var epoch = adRevenueEpoch;
                return dispatcher.Post(() => {
                    lock (adRevenueGate)
                    {
                        if (disposed || epoch != adRevenueEpoch || !adRevenueCollectionEnabled || !adRevenueConsentEnabled) return;
                        target.TrackAdRevenue(value);
                    }
                });
            }
        }

        private void ChangeAdRevenueCollection(bool enabled)
        {
            lock (adRevenueGate) { adRevenueEpoch++; adRevenueCollectionEnabled = enabled; }
        }

        private long BeginAdRevenueConsentChange()
        {
            lock (adRevenueGate) { adRevenueConsentEnabled = false; return ++adRevenueEpoch; }
        }

        private void CompleteAdRevenueConsentChange(long epoch, bool allowed, bool updated)
        {
            lock (adRevenueGate) if (epoch == adRevenueEpoch && !disposed) adRevenueConsentEnabled = allowed && updated;
        }

        private void ResetAdRevenueContext()
        {
            lock (adRevenueGate) { adRevenueEpoch++; adRevenueConsentEnabled = false; }
        }
    }
}
