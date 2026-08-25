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
        }
        Require(OpenMasuAndroidPlatform.ActiveAndroidObjectCount == 0, "AndroidJavaObject lease leaked");
        ExerciseIosCallbackPath(mainThread);
        Require(OpenMasuiOSPlatform.ActiveCallbackCount == 0, "iOS function-pointer callback leaked");
        Require(MaxRevenueSubscriptions.Formats.SequenceEqual(new[] { "Interstitial", "Rewarded", "Banner", "MRec" }), "MAX format subscription table is incomplete");
        OpenMasuMaxUnityAdapter.Subscribe();
        OpenMasuMaxUnityAdapter.Unsubscribe();
        var plist = OpenMasu.Unity.Editor.OpenMasuIosPlistSettings.Apply(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict/></plist>",
            "https://synthetic.example", "https://copy.synthetic.example");
        Require(plist.Contains("NSAdvertisingAttributionReportEndpoint"), "SKAN endpoint was not written");
        Require(plist.Contains("AttributionCopyEndpoint"), "AdAttributionKit endpoint was not written");
        Require(plist.Contains("OpenMasuCollectionEnabledDefault"), "collection default was not written");
        Require(plist.Contains("<false"), "collection default must be disabled unless explicitly enabled");
        Console.WriteLine("Unity bridge probe passed: Android and iOS 10000-callback paths, main-thread dispatch, zero callback/object leaks, both Apple plist keys, 4 MAX formats.");
        return 0;
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
        public void WaitForCallbacks() => callbacks.Wait(TimeSpan.FromSeconds(30));
        public void Dispose() => callbacks.Dispose();
    }
}
