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
        Require(MaxRevenueSubscriptions.Formats.SequenceEqual(new[] { "Interstitial", "Rewarded", "Banner", "MRec" }), "MAX format subscription table is incomplete");
        OpenMasuMaxUnityAdapter.Subscribe();
        OpenMasuMaxUnityAdapter.Unsubscribe();
        var plist = OpenMasu.Unity.Editor.OpenMasuIosPlistSettings.Apply(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict/></plist>",
            "https://synthetic.example", "https://copy.synthetic.example");
        Require(plist.Contains("NSAdvertisingAttributionReportEndpoint"), "SKAN endpoint was not written");
        Require(plist.Contains("AttributionCopyEndpoint"), "AdAttributionKit endpoint was not written");
        Require(plist.Contains("OpenMasuCollectionEnabledDefault"), "collection default was not written");
        Require(plist.Contains("OpenMasuLinkHosts"), "deep-link hosts were not written");
        Require(plist.Contains("OpenMasuLinkSchemes"), "deep-link schemes were not written");
        Require(plist.Contains("<false"), "collection default must be disabled unless explicitly enabled");
        var entitlements = OpenMasu.Unity.Editor.OpenMasuAssociatedDomains.Apply(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict/></plist>",
            new[] { "links.synthetic.invalid" });
        Require(entitlements.Contains("com.apple.developer.associated-domains"), "associated domains key was not written");
        Require(entitlements.Contains("applinks:links.synthetic.invalid"), "associated domain host was not written");
        Require(!entitlements.Contains("?mode="), "development associated-domain mode reached generated output");
        Console.WriteLine("Unity bridge probe passed: Android/iOS callbacks, additive purchase/refund platform, validation, Apple plist keys, 4 MAX formats.");
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
        }
    }

    private static void Require(bool value, string message)
    {
        if (!value) throw new InvalidOperationException(message);
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
}
