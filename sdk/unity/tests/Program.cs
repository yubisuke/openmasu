using System;
using System.IO;
using System.Linq;
using System.Threading;
using System.Xml.Linq;
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
        ExerciseAndroidManifestGeneration();
        ExerciseAndroidGradleSettings();
        ExerciseAndroidPostprocessorWithoutLinkSettings();
        ExerciseIosPostprocessorTargetMembership();
        Require(MaxRevenueSubscriptions.Formats.SequenceEqual(new[] { "Interstitial", "Rewarded", "Banner", "MRec" }), "MAX format subscription table is incomplete");
        ExerciseAndroidMaxFormatBridge();
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

    private static void ExerciseAndroidMaxFormatBridge()
    {
        var adInfo = new MaxSdk.AdInfo
        {
            Revenue = 0.25,
            RevenuePrecision = "exact",
            NetworkName = "Synthetic Network",
            AdUnitIdentifier = "ad-unit:synthetic",
            Placement = "placement:synthetic",
            NetworkPlacement = "network-placement:synthetic",
        };
        foreach (var format in new[] { "interstitial", "rewarded", "banner", "mrec" })
        {
            var arguments = OpenMasuMaxUnityAdapter.AndroidRevenueArguments(adInfo, format.ToUpperInvariant());
            Require(arguments.Length == 7, "Unity Android MAX bridge argument count changed");
            Require((string)arguments[4] == format, "Unity Android MAX format was lost");
        }
        Require(OpenMasuMaxUnityAdapter.NormalizeFormat("native") == "unknown",
            "unsupported Unity MAX format was not normalized explicitly");
    }

    private static void ExerciseAndroidManifestGeneration()
    {
        const string androidNamespace = "http://schemas.android.com/apk/res/android";
        const string input = "<?xml version=\"1.0\" encoding=\"utf-8\"?>" +
            "<manifest xmlns:android=\"http://schemas.android.com/apk/res/android\"><application>" +
            "<activity android:name=\"com.unity3d.player.UnityPlayerActivity\" android:exported=\"true\">" +
            "<intent-filter><action android:name=\"android.intent.action.VIEW\"/>" +
            "<category android:name=\"android.intent.category.DEFAULT\"/>" +
            "<category android:name=\"android.intent.category.BROWSABLE\"/>" +
            "<data android:scheme=\"openmasu-synthetic\"/></intent-filter>" +
            "</activity></application></manifest>";

        var generated = OpenMasu.Unity.Editor.OpenMasuAndroidManifestSettings.Apply(
            input,
            new[] { " B.SYNTHETIC.EXAMPLE. ", "a.synthetic.example", "a.synthetic.example" });
        generated = OpenMasu.Unity.Editor.OpenMasuAndroidManifestSettings.Apply(
            generated,
            new[] { "a.synthetic.example", "b.synthetic.example" });

        var document = XDocument.Parse(generated);
        XNamespace android = androidNamespace;
        var application = document.Root.Element("application");
        var activity = application.Elements("activity").Single();
        var openMasuFilters = activity.Elements("intent-filter")
            .Where(value => (string)value.Attribute(android + "label") ==
                OpenMasu.Unity.Editor.OpenMasuAndroidManifestSettings.LinkFilterLabel)
            .ToArray();
        Require(openMasuFilters.Length == 2, "Android manifest did not contain one OpenMasu filter per host");
        Require(openMasuFilters.Select(value => (string)value.Elements("data")
                .Single(data => data.Attribute(android + "host") != null).Attribute(android + "host"))
            .SequenceEqual(new[] { "a.synthetic.example", "b.synthetic.example" }),
            "Android manifest link hosts were not normalized and sorted");
        Require(openMasuFilters.All(value => value.Elements("data")
                .Where(data => data.Attribute(android + "scheme") != null)
                .Select(data => (string)data.Attribute(android + "scheme"))
                .SequenceEqual(new[] { "http", "https" })),
            "Android App Links schemes changed");
        Require(activity.Elements("intent-filter").Any(value => value.Elements("data")
                .Any(data => (string)data.Attribute(android + "scheme") == "openmasu-synthetic")),
            "operator-owned custom-scheme filter was removed");
        Require((string)application.Elements("meta-data").Single(value =>
                (string)value.Attribute(android + "name") ==
                OpenMasu.Unity.Editor.OpenMasuAndroidManifestSettings.LinkHostsMetadataName)
            .Attribute(android + "value") == "a.synthetic.example,b.synthetic.example",
            "Android manifest host metadata did not match generated filters");

        var gameActivityInput = input.Replace(
            OpenMasu.Unity.Editor.OpenMasuAndroidManifestSettings.DefaultActivityName,
            OpenMasu.Unity.Editor.OpenMasuAndroidManifestSettings.UnityGameActivityName);
        var gameActivityOutput = OpenMasu.Unity.Editor.OpenMasuAndroidManifestSettings.Apply(
            gameActivityInput,
            new[] { "links.synthetic.example" });
        Require(XDocument.Parse(gameActivityOutput).Descendants("activity")
                .Single().Elements("intent-filter")
                .Any(value => (string)value.Attribute(android + "label") ==
                    OpenMasu.Unity.Editor.OpenMasuAndroidManifestSettings.LinkFilterLabel),
            "Unity GameActivity did not receive the Android App Links filter");

        RequireArgumentFailureCode(
            () => OpenMasu.Unity.Editor.OpenMasuAndroidManifestSettings.Apply(
                input, new[] { "links.synthetic.invalid" }),
            "synthetic_link_host_forbidden",
            "checked-in synthetic Android link host reached a generated manifest");
        RequireArgumentFailureCode(
            () => OpenMasu.Unity.Editor.OpenMasuAndroidManifestSettings.Apply(input, Array.Empty<string>()),
            "link_hosts_required",
            "empty Android link-host settings generated an App Links filter");
    }

    private static void ExerciseAndroidGradleSettings()
    {
        const string input = "pluginManagement { repositories { google() } }\n" +
            "include ':launcher'\ninclude ':unityLibrary'\ninclude 'unityLibrary:OpenMasu.androidlib'\n" +
            "dependencyResolutionManagement {\n" +
            "    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)\n" +
            "    repositories {\n        google()\n        mavenCentral()\n    }\n}\n";
        var generated = OpenMasu.Unity.Editor.OpenMasuAndroidGradleSettings.Apply(input);
        Require(generated.Contains("exclusiveContent"),
            "packaged OpenMasu Maven repository was not injected at settings scope");
        Require(generated.Contains("includeGroup 'dev.openmasu'"),
            "packaged OpenMasu Maven repository was not group-restricted");
        Require(generated.Contains("unityLibrary/OpenMasu.androidlib/maven"),
            "packaged OpenMasu Maven repository path changed");
        Require(OpenMasu.Unity.Editor.OpenMasuAndroidGradleSettings.Apply(generated) == generated,
            "packaged OpenMasu Maven repository injection was not idempotent");
    }

    private static void ExerciseAndroidPostprocessorWithoutLinkSettings()
    {
        var root = Path.Combine(Path.GetTempPath(), "openmasu-unity-postprocessor-" + Guid.NewGuid().ToString("N"));
        var previous = Directory.GetCurrentDirectory();
        try
        {
            var unityLibrary = Path.Combine(root, "export", "unityLibrary");
            Directory.CreateDirectory(Path.Combine(unityLibrary, "OpenMasu.androidlib", "maven"));
            Directory.CreateDirectory(Path.Combine(root, "ProjectSettings"));
            File.WriteAllText(Path.Combine(root, "export", "settings.gradle"),
                "dependencyResolutionManagement {\n    repositories {\n        google()\n    }\n}\n");
            Directory.SetCurrentDirectory(root);
            new OpenMasu.Unity.Editor.OpenMasuAndroidPostprocessor()
                .OnPostGenerateGradleAndroidProject(unityLibrary);
            var generated = File.ReadAllText(Path.Combine(root, "export", "settings.gradle"));
            Require(generated.Contains(OpenMasu.Unity.Editor.OpenMasuAndroidGradleSettings.BeginMarker),
                "packaged Maven repository depends on optional App Links settings");
        }
        finally
        {
            Directory.SetCurrentDirectory(previous);
            if (Directory.Exists(root)) Directory.Delete(root, true);
        }
    }

    private static void ExerciseIosPostprocessorTargetMembership()
    {
        var root = Path.Combine(Path.GetTempPath(), "openmasu-unity-ios-postprocessor-" + Guid.NewGuid().ToString("N"));
        var previous = Directory.GetCurrentDirectory();
        try
        {
            var export = Path.Combine(root, "export");
            var projectSettings = Path.Combine(root, "ProjectSettings");
            var packageRoot = Path.Combine(root, "Packages", "com.openmasu.sdk", "Runtime", "Plugins", "iOS");
            var swiftRoot = Path.Combine(packageRoot, "Sources");
            var coreSource = Path.Combine(swiftRoot, "OpenMasuCore", "Synthetic.swift");
            var bridgeSource = Path.Combine(swiftRoot, "OpenMasuObjC", "SyntheticBridge.swift");
            var schemaSource = Path.Combine(
                swiftRoot, "OpenMasuApplePostback", "Resources", "conversion-schema-v1.json");
            Directory.CreateDirectory(projectSettings);
            Directory.CreateDirectory(Path.GetDirectoryName(coreSource));
            Directory.CreateDirectory(Path.GetDirectoryName(bridgeSource));
            Directory.CreateDirectory(Path.GetDirectoryName(schemaSource));
            Directory.CreateDirectory(Path.Combine(export, "Unity-iPhone.xcodeproj"));
            File.WriteAllText(Path.Combine(projectSettings, "OpenMasuIOSSettings.json"),
                "{\"skanEndpoint\":\"https://measurement.example\"," +
                "\"attributionCopyEndpoint\":\"https://measurement.example\"," +
                "\"linkHosts\":[\"links.example\"]}");
            File.WriteAllText(coreSource, "public enum SyntheticCore {}\n");
            File.WriteAllText(bridgeSource, "public enum SyntheticBridge {}\n");
            File.WriteAllText(schemaSource, "{\"version\":1}\n");
            File.WriteAllText(Path.Combine(packageRoot, "PrivacyInfo.xcprivacy"),
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict/></plist>");
            File.WriteAllText(Path.Combine(export, "Info.plist"),
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict/></plist>");
            File.WriteAllText(
                Path.Combine(export, "Unity-iPhone.xcodeproj", "project.pbxproj"),
                "// synthetic input\n");

            Directory.SetCurrentDirectory(root);
            OpenMasu.Unity.Editor.OpenMasuIOSPostprocessor.OnPostProcessBuild(
                UnityEditor.BuildTarget.iOS, export);

            var project = UnityEditor.iOS.Xcode.PBXProject.LastWrittenProject;
            Require(project != null, "Unity iOS postprocessor did not write the PBX project");
            var main = UnityEditor.iOS.Xcode.PBXProject.MainTargetGuid;
            var framework = UnityEditor.iOS.Xcode.PBXProject.FrameworkTargetGuid;
            foreach (var source in new[] {
                "OpenMasu/Sources/OpenMasuCore/Synthetic.swift",
                "OpenMasu/Sources/OpenMasuObjC/SyntheticBridge.swift"
            })
            {
                Require(project.HasBuildFile(framework, source),
                    "Swift source was not added to UnityFramework: " + source);
                Require(!project.HasBuildFile(main, source),
                    "Swift source was incorrectly added to the main app target: " + source);
            }
            Require(project.HasBuildProperty(framework, "SWIFT_VERSION", "5.0"),
                "UnityFramework Swift version is missing");
            Require(project.HasBuildProperty(framework, "CLANG_ENABLE_MODULES", "YES"),
                "UnityFramework modules setting is missing");
            Require(project.HasBuildProperty(framework, "OTHER_LDFLAGS", "-lsqlite3"),
                "UnityFramework sqlite linker setting is missing");
            Require(!project.HasAnyBuildProperty(main, "SWIFT_VERSION"),
                "Swift version leaked onto the main app target");
            Require(!project.HasAnyBuildProperty(main, "OTHER_LDFLAGS"),
                "sqlite linker setting leaked onto the main app target");
            Require(project.HasBuildProperty(main, "CODE_SIGN_ENTITLEMENTS", "OpenMasu/OpenMasu.entitlements"),
                "associated-domain entitlements were not assigned to the main app target");
            Require(!project.HasAnyBuildProperty(framework, "CODE_SIGN_ENTITLEMENTS"),
                "app entitlements were incorrectly assigned to UnityFramework");
            foreach (var resource in new[] { "PrivacyInfo.xcprivacy", "OpenMasu/conversion-schema-v1.json" })
            {
                Require(project.HasBuildFile(main, resource),
                    "app-bundle resource was not added to the main target: " + resource);
                Require(!project.HasBuildFile(framework, resource),
                    "app-bundle resource was incorrectly added to UnityFramework: " + resource);
            }
        }
        finally
        {
            Directory.SetCurrentDirectory(previous);
            if (Directory.Exists(root)) Directory.Delete(root, true);
        }
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

    private static void RequireArgumentFailureCode(Action action, string code, string message)
    {
        try { action(); }
        catch (ArgumentException error) when (error.Message.Contains(code)) { return; }
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
