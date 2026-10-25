using System;
using System.Linq;
using System.Threading;
using OpenMasu.Unity;
using OpenMasu.Unity.Integrations;
using Unity.Services.LevelPlay;

internal static partial class Program
{
    private static void ExerciseLevelPlayAdapter(string exportPath = null)
    {
        var platform = new AdRevenueProbePlatform(Environment.CurrentManagedThreadId);
        using (var client = new OpenMasuClient(platform, new OpenMasuDispatcher()))
        using (var binding = new OpenMasuLevelPlayAdapter(client))
        {
            var rewarded = new LevelPlayRewardedAd();
            var interstitial = new LevelPlayInterstitialAd();
            var banner = new LevelPlayBannerAd();
            binding.Subscribe(rewarded, "synthetic-rewarded"); binding.Subscribe(rewarded, "synthetic-rewarded");
            binding.Subscribe(interstitial, "synthetic-interstitial"); binding.Subscribe(banner, "synthetic-banner");
            Require(rewarded.Subscribers == 1 && interstitial.Subscribers == 1 && banner.Subscribers == 1, "per-ad subscription duplicated or missed an object");
            RequireArgumentFailureCode(() => binding.Subscribe(rewarded, "synthetic-other"), "levelplay_subscription_conflict", "same ad silently changed its explicit unit binding");
            LevelPlayImpressionData Data(string auction, double? revenue, string precision) => new LevelPlayImpressionData {
                AuctionId = auction, Revenue = revenue, Precision = precision, AdNetwork = "synthetic-ad-network",
            };
            var reward = Data("synthetic-auction-rewarded", 1.25, "BID");
            rewarded.Raise(reward); client.PumpCallbacks();
            Require(platform.Events.Count == 0 && binding.RejectedCount == 1, "default-off callback collected");
            client.SetCollectionEnabled(true);
            client.UpdateConsent(OpenMasuConsentState.Granted, "policy:synthetic", _ => { });
            platform.ConsentCompletion("state=updated"); client.PumpCallbacks();
            var background = new Thread(() => {
                rewarded.Raise(reward);
                interstitial.Raise(Data("synthetic-auction-interstitial", 0.5, "RATE"));
                banner.Raise(Data("synthetic-auction-banner", 0.25, "CPM"));
            });
            background.Start(); background.Join();
            Require(platform.Events.Count == 0, "provider background callback called the native bridge directly");
            client.PumpCallbacks();
            Require(platform.Events.Count == 3, "three ad objects did not reach dispatch");
            Require(platform.Events.Select(value => value.RevenuePrecision).SequenceEqual(new[] { "exact", "publisher_defined", "estimated" }), "ILR precision mapping changed");
            Require(platform.Events.Select(value => value.AdFormat).SequenceEqual(new[] { "rewarded", "interstitial", "banner" }), "format was inferred from names instead of the subscribed object");
            Require(platform.Events.Sum(value => long.Parse(value.AmountUnscaled)) == 2_000_000, "callback USD amount changed");
            Require(platform.Events.All(value => value.MediationProvider == "unity-levelplay"), "mediation source was mislabeled as MAX");
            rewarded.Raise(reward); client.PumpCallbacks();
            Require(platform.Events[0].ImpressionId == platform.Events[3].ImpressionId, "duplicate callback invented a new logical event ID");
            if (exportPath != null)
                System.IO.File.WriteAllText(exportPath, System.Text.Json.JsonSerializer.Serialize(platform.Events));
            var stale = rewarded.Pending(reward);
            binding.Unsubscribe(rewarded); stale(); client.PumpCallbacks();
            Require(rewarded.Subscribers == 0 && platform.Events.Count == 4, "unsubscribed in-flight callback was newly dispatched");
            binding.Subscribe(rewarded, "synthetic-rewarded");
            Require(rewarded.Subscribers == 1, "resubscription failed");
            foreach (var amount in new double?[] { null, double.NaN, double.PositiveInfinity, -1 })
                rewarded.Raise(Data("synthetic-invalid", amount, null));
            rewarded.Raise(null); client.PumpCallbacks();
            Require(platform.Events.Count == 4 && binding.RejectedCount == 6, "invalid/missing callback became zero revenue");
            banner.Raise(Data("synthetic-unknown-precision", 0, null)); client.PumpCallbacks();
            Require(platform.Events.Last().AmountUnscaled == "0" && platform.Events.Last().RevenuePrecision == "undefined", "known zero with unknown precision was rewritten");
            rewarded.Raise(reward);
            client.UpdateConsent(OpenMasuConsentState.Withdrawn, "policy:synthetic", _ => { });
            platform.ConsentCompletion("state=updated"); client.PumpCallbacks();
            Require(platform.Events.Count == 5, "withdrawn pending callback reached the native bridge");
            binding.Dispose();
            Require(rewarded.Subscribers == 0 && interstitial.Subscribers == 0 && banner.Subscribers == 0, "disposing the binding leaked ad subscriptions");
        }
        Console.WriteLine("LevelPlay API shim passed: per-ad ownership, background dispatch, precision, repeated identity, null money, unsubscribe/resubscribe and consent withdrawal; not actual provider SDK execution.");
    }
}
