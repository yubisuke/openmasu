using System;
using System.Linq;
using System.Threading;
using OpenMasu.Unity;

internal static class Program
{
    private static int Main()
    {
        var mainThread = Environment.CurrentManagedThreadId;
        var dispatcher = new OpenMasuDispatcher(20_000);
        using (var platform = new SyntheticPlatform())
        using (var client = new OpenMasuClient(platform, dispatcher))
        {
            var received = 0;
            for (var index = 0; index < 10_000; index++)
            {
                var expected = "value-" + index;
                client.PingFromBackground(expected, actual =>
                {
                    Require(actual == expected, "Unity callback value changed");
                    Require(Environment.CurrentManagedThreadId == mainThread, "Unity callback did not reach the main thread");
                    received++;
                });
            }
            platform.WaitForCallbacks();
            while (received < 10_000) client.PumpCallbacks();
            Require(received == 10_000, "Unity callback count mismatch");
            Require(dispatcher.DroppedCount == 0, "Unity dispatcher dropped callbacks");
            OpenMasuDeepLink deepLink = null;
            client.SetDeepLinkListener(value => {
                Require(Environment.CurrentManagedThreadId == mainThread, "deep-link callback did not reach the main thread");
                deepLink = value;
            });
            client.HandleDeepLink("https://links.synthetic.invalid/r/Synthetic123/synthetic");
            while (deepLink == null) { client.PumpCallbacks(); Thread.Yield(); }
            Require(deepLink.Value == "/synthetic", "deep-link destination changed");
            deepLink = null;
            client.AttachUnityDeepLinkForwarding();
            UnityEngine.Application.RaiseDeepLink("https://links.synthetic.invalid/r/Synthetic123/synthetic");
            while (deepLink == null) { client.PumpCallbacks(); Thread.Yield(); }
        }
        Require(OpenMasuAndroidPlatform.ActiveAndroidObjectCount == 0, "AndroidJavaObject lease leaked");
        ExerciseIosCallbackPath(mainThread);
        Require(OpenMasuiOSPlatform.ActiveCallbackCount == 0, "iOS function-pointer callback leaked");
        ExerciseRevenuePlatformCompatibility();
        ExerciseAppleConversionPlatformCompatibility();
        Require(MaxRevenueSubscriptions.Formats.SequenceEqual(new[] { "Interstitial", "Rewarded", "Banner", "MRec" }), "MAX format subscription table is incomplete");
        OpenMasuMaxUnityAdapter.Subscribe();
        OpenMasuMaxUnityAdapter.Unsubscribe();
        var plist = OpenMasu.Unity.Editor.OpenMasuIosPlistSettings.Apply(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict/></plist>",
            "https://skan.example", "https://aak.example");
        Require(plist.Contains("NSAdvertisingAttributionReportEndpoint"), "SKAN endpoint was not written");
        Require(plist.Contains("AttributionCopyEndpoint"), "AdAttributionKit endpoint was not written");
        Require(plist.Contains("<string>https://skan.example</string>"), "SKAN origin changed in generated plist");
        Require(plist.Contains("<string>https://aak.example</string>"), "AdAttributionKit origin changed in generated plist");
        Require(plist.Contains("OpenMasuCollectionEnabledDefault"), "collection default was not written");
        Require(plist.Contains("OpenMasuLinkHosts"), "deep-link hosts were not written");
        Require(plist.Contains("OpenMasuLinkSchemes"), "deep-link schemes were not written");
        Require(plist.Contains("EligibleForAdAttributionKitReengagementPostbackCopies"), "re-engagement copy opt-in was not written");
        Require(plist.Contains("EligibleForAdAttributionKitOverlappingConversions"), "overlapping conversion opt-in was not written");
        Require(plist.Contains("<false"), "collection default must be disabled unless explicitly enabled");
        var optedInPlist = OpenMasu.Unity.Editor.OpenMasuIosPlistSettings.Apply(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict/></plist>",
            "https://skan.example", "https://aak.example",
            false, null, null, true, true);
        Require(optedInPlist.Contains("<key>EligibleForAdAttributionKitReengagementPostbackCopies</key><true"),
            "re-engagement copy opt-in was not enabled");
        Require(optedInPlist.Contains("<key>EligibleForAdAttributionKitOverlappingConversions</key><true"),
            "overlapping conversion opt-in was not enabled");
        foreach (var invalidEndpoint in new[] {
            "https://synthetic.example/skan",
            "https://synthetic.example?copy=1",
            "https://synthetic.example#copy",
            "https://operator@synthetic.example",
            "https://synthetic.example:8443",
            "http://synthetic.example"
        })
        {
            RequireArgumentFailure(() => OpenMasu.Unity.Editor.OpenMasuIosPlistSettings.Apply(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict/></plist>",
                invalidEndpoint, "https://aak.example"),
                "SKAN accepted a non-origin endpoint: " + invalidEndpoint);
            RequireArgumentFailure(() => OpenMasu.Unity.Editor.OpenMasuIosPlistSettings.Apply(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict/></plist>",
                "https://skan.example", invalidEndpoint),
                "AdAttributionKit accepted a non-origin endpoint: " + invalidEndpoint);
        }
        var entitlements = OpenMasu.Unity.Editor.OpenMasuAssociatedDomains.Apply(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict/></plist>",
            new[] { "links.synthetic.invalid" });
        Require(entitlements.Contains("com.apple.developer.associated-domains"), "associated domains key was not written");
        Require(entitlements.Contains("applinks:links.synthetic.invalid"), "associated domain host was not written");
        Require(!entitlements.Contains("?mode="), "development associated-domain mode reached generated output");
        Console.WriteLine("Unity bridge probe passed: Android/iOS callbacks, purchase/refund and Apple conversion platforms, validation, Apple plist keys, 4 MAX formats.");
        return 0;
    }

    private static void ExerciseRevenuePlatformCompatibility()
    {
        using (var legacyPlatform = new SyntheticPlatform())
        using (var legacyClient = new OpenMasuClient(legacyPlatform, new OpenMasuDispatcher(8)))
        {
            var unavailable = false;
            try { legacyClient.TrackPurchase("transaction:legacy-49", "1", 0, "USD"); }
            catch (NotSupportedException) { unavailable = true; }
            Require(unavailable, "legacy IOpenMasuPlatform implementer was treated as a revenue platform");
            unavailable = false;
            try { legacyClient.GetQueueHealth(_ => { }); }
            catch (NotSupportedException) { unavailable = true; }
            Require(unavailable, "legacy IOpenMasuPlatform implementer was treated as a queue-health platform");
        }

        using (var platform = new SyntheticRevenuePlatform())
        using (var client = new OpenMasuClient(platform, new OpenMasuDispatcher(8)))
        {
            client.TrackPurchase("transaction:synthetic-49", "1250", 2, "USD");
            client.TrackRefund("refund:synthetic-49", "transaction:synthetic-49", "1250", 2, "USD");
            Require(platform.PurchaseCount == 1, "purchase helper did not reach the additive revenue platform");
            Require(platform.RefundCount == 1, "refund helper did not reach the additive revenue platform");
            var rejected = false;
            try { client.TrackPurchase("transaction:negative-49", "-1", 2, "USD"); }
            catch (ArgumentException) { rejected = true; }
            Require(rejected && platform.PurchaseCount == 1, "negative money reached the native bridge");
        }
    }

    private static void ExerciseAppleConversionPlatformCompatibility()
    {
        using (var legacyPlatform = new SyntheticPlatform())
        using (var legacyClient = new OpenMasuClient(legacyPlatform, new OpenMasuDispatcher(8)))
        {
            var unavailable = false;
            try
            {
                legacyClient.RecordAppleConversion(
                    "purchase",
                    OpenMasuAppleConversionTarget.Install,
                    _ => { });
            }
            catch (NotSupportedException) { unavailable = true; }
            Require(unavailable, "legacy IOpenMasuPlatform implementer was treated as an Apple conversion platform");
        }

        var dispatcher = new OpenMasuDispatcher(8);
        using (var platform = new SyntheticAppleConversionPlatform())
        using (var client = new OpenMasuClient(platform, dispatcher))
        {
            var rejected = false;
            try
            {
                client.RecordAppleConversion(
                    "purchase",
                    OpenMasuAppleConversionTarget.Install,
                    "synthetic-tag",
                    _ => { });
            }
            catch (ArgumentException) { rejected = true; }
            Require(rejected && platform.ConversionCount == 0,
                "an install-only conversion tag reached the native bridge");

            bool? completed = null;
            client.RecordAppleConversion(
                "purchase",
                OpenMasuAppleConversionTarget.Reengagement,
                "synthetic-tag",
                value => completed = value);
            while (completed == null) { dispatcher.Pump(); Thread.Yield(); }
            Require(completed == true, "Apple conversion callback failed");
            Require(platform.ConversionCount == 1, "Apple conversion did not reach the additive platform");
            Require(platform.EventName == "purchase", "Apple conversion event changed");
            Require(platform.Targets == OpenMasuAppleConversionTarget.Reengagement,
                "Apple conversion target changed");
            Require(platform.ConversionTag == "synthetic-tag", "Apple conversion tag changed");
        }
    }

    private static void ExerciseIosCallbackPath(int mainThread)
    {
        var dispatcher = new OpenMasuDispatcher(20_000);
        using (var platform = new OpenMasuiOSPlatform())
        using (var client = new OpenMasuClient(platform, dispatcher))
        {
            var received = 0;
            for (var index = 0; index < 10_000; index++)
            {
                var expected = "ios-value-" + index;
                client.PingFromBackground(expected, actual =>
                {
                    Require(actual == expected, "iOS callback value changed");
                    Require(Environment.CurrentManagedThreadId == mainThread, "iOS callback did not reach main thread");
                    received++;
                });
            }
            var deadline = DateTime.UtcNow.AddSeconds(30);
            while (received < 10_000 && DateTime.UtcNow < deadline)
            {
                client.PumpCallbacks();
                Thread.Yield();
            }
            Require(received == 10_000, "iOS callback count mismatch");
            Require(dispatcher.DroppedCount == 0, "iOS dispatcher dropped callbacks");
            OpenMasuQueueHealth health = null;
            client.GetQueueHealth(value => health = value);
            var healthDeadline = DateTime.UtcNow.AddSeconds(5);
            while (health == null && DateTime.UtcNow < healthDeadline)
            {
                client.PumpCallbacks();
                Thread.Yield();
            }
            Require(health != null && health.PendingCount == 0 && health.LogicalBytes == 0 &&
                health.EvictedTotal == 0 && health.RejectedTotal == 0,
                "iOS queue-health callback changed aggregate values");
            bool? conversionUpdated = null;
            client.RecordAppleConversion(
                "purchase",
                OpenMasuAppleConversionTarget.Reengagement,
                "synthetic-tag",
                value => conversionUpdated = value);
            var conversionDeadline = DateTime.UtcNow.AddSeconds(5);
            while (conversionUpdated == null && DateTime.UtcNow < conversionDeadline)
            {
                client.PumpCallbacks();
                Thread.Yield();
            }
            Require(conversionUpdated == true, "iOS Apple conversion callback failed");
        }
    }

    private static void Require(bool value, string message)
    {
        if (!value) throw new InvalidOperationException(message);
    }

    private static void RequireArgumentFailure(Action action, string message)
    {
        try { action(); }
        catch (ArgumentException error) when (error.Message.Contains("endpoint_must_be_https_origin")) { return; }
        throw new InvalidOperationException(message);
    }

    private sealed class SyntheticPlatform : IOpenMasuPlatform
    {
        private readonly CountdownEvent callbacks = new CountdownEvent(10_000);
        public void Initialize(OpenMasuOptions options) { }
        public void TrackCustomEvent(string eventKey) { }
        public void StartSession() { }
        public void SetCollectionEnabled(bool enabled) { }
        public void ResetInstallationId(Action<bool> completion) => completion(true);
        public void PingFromBackground(string value, Action<string> completion)
        {
            new Thread(() => { completion(value); callbacks.Signal(); }) { IsBackground = true }.Start();
        }
        public void SetDeepLinkListener(Action<string> listener) => deepLinkListener = listener;
        public void HandleDeepLink(string url) => deepLinkListener?.Invoke("value=%2Fsynthetic&open_source=android_app_link&destination_status=delivered&link_slug=Synthetic123");
        private Action<string> deepLinkListener;
        public void WaitForCallbacks() => callbacks.Wait(TimeSpan.FromSeconds(30));
        public void Dispose() => callbacks.Dispose();
    }

    private sealed class SyntheticRevenuePlatform : IOpenMasuPlatform, IOpenMasuRevenuePlatform
    {
        public int PurchaseCount { get; private set; }
        public int RefundCount { get; private set; }
        public void Initialize(OpenMasuOptions options) { }
        public void TrackCustomEvent(string eventKey) { }
        public void TrackPurchase(
            string transactionId,
            string amountUnscaled,
            int amountScale,
            string currency)
        {
            PurchaseCount++;
        }
        public void TrackRefund(
            string transactionId,
            string originalTransactionId,
            string amountUnscaled,
            int amountScale,
            string currency)
        {
            RefundCount++;
        }
        public void StartSession() { }
        public void SetCollectionEnabled(bool enabled) { }
        public void ResetInstallationId(Action<bool> completion) => completion(true);
        public void PingFromBackground(string value, Action<string> completion) => completion(value);
        public void SetDeepLinkListener(Action<string> listener) { }
        public void HandleDeepLink(string url) { }
        public void Dispose() { }
    }

    private sealed class SyntheticAppleConversionPlatform : IOpenMasuPlatform, IOpenMasuAppleConversionPlatform
    {
        public int ConversionCount { get; private set; }
        public string EventName { get; private set; }
        public OpenMasuAppleConversionTarget Targets { get; private set; }
        public string ConversionTag { get; private set; }
        public void Initialize(OpenMasuOptions options) { }
        public void TrackCustomEvent(string eventKey) { }
        public void RecordAppleConversion(
            string eventName,
            OpenMasuAppleConversionTarget targets,
            string conversionTag,
            Action<bool> completion)
        {
            ConversionCount++;
            EventName = eventName;
            Targets = targets;
            ConversionTag = conversionTag;
            completion(true);
        }
        public void StartSession() { }
        public void SetCollectionEnabled(bool enabled) { }
        public void ResetInstallationId(Action<bool> completion) => completion(true);
        public void PingFromBackground(string value, Action<string> completion) => completion(value);
        public void SetDeepLinkListener(Action<string> listener) { }
        public void HandleDeepLink(string url) { }
        public void Dispose() { }
    }
}
