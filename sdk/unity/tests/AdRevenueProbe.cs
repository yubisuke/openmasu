using System;
using System.Collections.Generic;
using System.Threading;
using OpenMasu.Unity;

internal static partial class Program
{
    private static void ExerciseAdRevenue()
    {
        OpenMasuAdRevenueEvent Create(double? money, string auction = "synthetic-auction")
        {
            Require(OpenMasuAdRevenueEvent.TryCreateUsdImpression("unity-levelplay", auction, money,
                OpenMasuRevenuePrecision.Exact, "synthetic-network", "synthetic-unit", "rewarded", out var value), "valid ad revenue was refused");
            return value;
        }
        foreach (var invalid in new double?[] { null, double.NaN, double.PositiveInfinity, double.NegativeInfinity, -1, double.MaxValue })
            Require(!OpenMasuAdRevenueEvent.TryCreateUsdImpression("unity-levelplay", "synthetic-auction", invalid,
                OpenMasuRevenuePrecision.Exact, "synthetic-network", "synthetic-unit", "rewarded", out _), "invalid or missing money became revenue");
        Require(Create(0).AmountUnscaled == "0", "observed zero became missing");
        Require(Create(0.0000005).AmountUnscaled == "0" && Create(0.0000015).AmountUnscaled == "2", "USD micros did not round half-even");
        Require(Create(1.25).AmountUnscaled == "1250000", "exact USD micros changed");
        Require(Create(1.25).ImpressionId == Create(2.50).ImpressionId, "changed money invented a second impression identity");
        Require(Create(1.25).ImpressionId != Create(1.25, "synthetic-other-auction").ImpressionId, "distinct auction identity collided");
        var value = Create(1.25);
        Require(!value.ImpressionId.Contains("synthetic-auction"), "raw auction ID leaked into the opaque reference");

        var dispatcher = new OpenMasuDispatcher(4);
        var platform = new AdRevenueProbePlatform(Environment.CurrentManagedThreadId);
        using (var client = new OpenMasuClient(platform, dispatcher))
        {
            Require(!client.TryTrackAdRevenue(value), "default-off managed revenue collected");
            client.SetCollectionEnabled(true);
            Require(!client.TryTrackAdRevenue(value), "unacknowledged consent collected");
            client.UpdateConsent(OpenMasuConsentState.Granted, "policy:synthetic", _ => { });
            platform.ConsentCompletion("state=updated");
            Require(!client.TryTrackAdRevenue(value), "consent enabled before main-thread acknowledgement");
            client.PumpCallbacks();
            var accepted = false;
            var background = new Thread(() => accepted = client.TryTrackAdRevenue(value));
            background.Start(); background.Join();
            Require(accepted && platform.Events.Count == 0, "background callback invoked native Unity APIs before pumping");
            client.PumpCallbacks();
            Require(platform.Events.Count == 1 && ReferenceEquals(platform.Events[0], value), "managed revenue changed before native dispatch");

            Require(client.TryTrackAdRevenue(value), "enabled managed dispatch refused");
            client.UpdateConsent(OpenMasuConsentState.Withdrawn, "policy:synthetic", _ => { });
            platform.ConsentCompletion("state=updated");
            client.UpdateConsent(OpenMasuConsentState.Granted, "policy:synthetic", _ => { });
            platform.ConsentCompletion("state=updated");
            client.PumpCallbacks();
            Require(platform.Events.Count == 1, "withdrawal and regrant revived a stale callback");
            Require(client.TryTrackAdRevenue(value), "regrant did not enable new observations");
            client.SetCollectionEnabled(false); client.SetCollectionEnabled(true); client.PumpCallbacks();
            Require(platform.Events.Count == 1, "collection pause revived a stale callback");
            Require(client.TryTrackAdRevenue(value), "collection re-enable refused a new observation");
            client.ResetInstallationId(_ => { }); client.PumpCallbacks();
            Require(platform.Events.Count == 1 && !client.TryTrackAdRevenue(value), "installation reset revived old revenue context");
            client.UpdateConsent(OpenMasuConsentState.NotRequired, "policy:synthetic", _ => { });
            platform.ConsentCompletion("state=updated"); client.PumpCallbacks();
            Require(client.TryTrackAdRevenue(value), "explicit not-required consent refused");
            client.Dispose(); client.PumpCallbacks();
            Require(platform.Events.Count == 1, "disposed client invoked the native revenue bridge");
        }
        Console.WriteLine("Managed ad revenue passed: nullable money, exact micros, opaque repeat identity, main-thread dispatch, consent epochs, pause/reset and disposal.");
    }

    private sealed class AdRevenueProbePlatform : IOpenMasuPlatform, IOpenMasuAdRevenuePlatform, IOpenMasuConsentPlatform
    {
        private readonly int threadId;
        public readonly List<OpenMasuAdRevenueEvent> Events = new List<OpenMasuAdRevenueEvent>();
        public Action<string> ConsentCompletion;
        public AdRevenueProbePlatform(int threadId) { this.threadId = threadId; }
        public void TrackAdRevenue(OpenMasuAdRevenueEvent value)
        { Require(Environment.CurrentManagedThreadId == threadId, "native revenue bridge called off the Unity thread"); Events.Add(value); }
        public void UpdateConsent(string state, string policy, Action<string> completion) => ConsentCompletion = completion;
        public void Initialize(OpenMasuOptions options) { }
        public void TrackCustomEvent(string eventKey) { }
        public void StartSession() { }
        public void SetCollectionEnabled(bool enabled) { }
        public void ResetInstallationId(Action<bool> completion) => completion(true);
        public void PingFromBackground(string value, Action<string> completion) => completion(value);
        public void SetDeepLinkListener(Action<string> listener) { }
        public void HandleDeepLink(string url) { }
        public void Dispose() { }
    }
}
