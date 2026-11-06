using System;
using System.IO;
using System.Text.Json;
using System.Threading;
using OpenMasu.Unity;

internal static partial class Program
{
    private static void ExerciseAppleMeaning(int mainThread)
    {
        var bundle = File.ReadAllText("sdk/unity/com.openmasu.sdk/Samples~/iOSMeasurement/conversion-meaning.synthetic.json");
        var configuration = OpenMasuAppleMeaningConfiguration.FromBundle(bundle);
        Require(configuration.SchemaDigest == "1f1d34137531516b47d84f489342966738e4a50d18110e9d3ced2dfc5202b5e0", "registered SDK digest changed");
        RequireArgumentFailureCode(() => new OpenMasuAppleMeaningConfiguration(configuration.CanonicalDefinition, "2.0.0", new string('0', 64)), "conversion_schema_digest_mismatch", "invalid digest accepted");
        RequireArgumentFailureCode(() => OpenMasuAppleMeaningConfiguration.FromBundle(bundle.Replace("openmasu.apple-conversion-meaning.v1", "unknown")), "conversion_meaning_bundle_invalid", "unknown bundle accepted");
        using var vector = JsonDocument.Parse(File.ReadAllText("sdk/ios/Tests/OpenMasuApplePostbackTests/Vectors/meaning.json"));
        using var platform = new SyntheticMeaningPlatform();
        using var client = new OpenMasuClient(platform, new OpenMasuDispatcher());
        OpenMasuAppleMeaningResult result = null;
        Action<OpenMasuAppleMeaningResult> completion = value => {
            Require(Environment.CurrentManagedThreadId == mainThread, "meaning callback left main thread"); result = value;
        };
        void AwaitResult() {
            var until = DateTime.UtcNow.AddSeconds(5);
            while (result == null && DateTime.UtcNow < until) { client.PumpCallbacks(); Thread.Yield(); }
            Require(result != null, "meaning callback missing");
        }
        SyntheticAppleMeaningSample.Initialize(client, new OpenMasuOptions(), bundle, completion);
        AwaitResult(); Require(result.State == OpenMasuAppleMeaningState.Ready, "meaning initialization result changed");
        Require(platform.Configuration.CanonicalDefinition == configuration.CanonicalDefinition && platform.Configuration.SchemaVersion == configuration.SchemaVersion
            && platform.Configuration.SchemaDigest == configuration.SchemaDigest, "definition/version/digest changed across managed bridge");
        foreach (var row in vector.RootElement.GetProperty("cases").EnumerateArray())
        {
            platform.Response = "state=updated&fine=" + row.GetProperty("fine").GetInt32() + "&coarse=" + row.GetProperty("coarse").GetString()
                + "&lock=" + row.GetProperty("lock").GetBoolean().ToString().ToLowerInvariant();
            result = null;
            client.RecordAppleMeaning("synthetic-operation", "purchase", row.GetProperty("revenue").GetString(), OpenMasuAppleWindow.Second, true, completion);
            AwaitResult();
            Require(result.State == OpenMasuAppleMeaningState.Updated && result.FineValue == row.GetProperty("fine").GetInt32(), "shared native fine result changed");
            Require(result.CoarseValue.ToString().ToLowerInvariant() == row.GetProperty("coarse").GetString() && result.LockPostback == row.GetProperty("lock").GetBoolean(), "shared native coarse/lock changed");
            Require(platform.Operation == "synthetic-operation" && platform.Event == "purchase" && platform.Amount == row.GetProperty("revenue").GetString()
                && platform.Window == OpenMasuAppleWindow.Second && platform.Consent, "typed native arguments changed");
        }
        foreach (var error in new[] { "digest_mismatch", "event_conflict", "consent_required", "context_changed", "invalid_signal", "invalid_revenue", "state_limit" })
        {
            result = null; platform.Response = "state=not_applied&error=" + error;
            client.RecordAppleMeaning("retry", "onboarding_complete", null, OpenMasuAppleWindow.Third, false, completion);
            AwaitResult(); Require(result.State == OpenMasuAppleMeaningState.NotApplied && result.FineValue == null, "failure became an update");
            Require(result.Error.ToString().ToLowerInvariant() == error.Replace("_", ""), "native error meaning changed");
            Require(platform.Amount == null && !platform.Consent && platform.Window == OpenMasuAppleWindow.Third, "null amount or explicit consent/window changed");
        }
        foreach (var bad in new[] { "1.25", "-1", "01", "100\n", "1000000000000000" })
            RequireArgumentFailureCode(() => client.RecordAppleMeaning("key", "purchase", bad, OpenMasuAppleWindow.First, true, completion), "conversion_revenue_invalid", "invalid amount reached native");
        RequireArgumentFailureCode(() => client.RecordAppleMeaning("key", "purchase", "1", (OpenMasuAppleWindow)3, true, completion), "conversion_window_invalid", "invalid window reached native");
        using (var ios = new OpenMasuClient(new OpenMasuiOSPlatform(), new OpenMasuDispatcher()))
        {
            result = null;
            ios.InitializeAppleMeaning(new OpenMasuOptions(), configuration, completion);
            var until = DateTime.UtcNow.AddSeconds(5);
            while (result == null && DateTime.UtcNow < until) { ios.PumpCallbacks(); Thread.Yield(); }
            Require(result?.Error == OpenMasuAppleMeaningError.PlatformUnavailable, "Editor claimed native meaning initialization");
        }
        using (var legacy = new OpenMasuClient(new SyntheticAppleConversionPlatform(), new OpenMasuDispatcher()))
        {
            var refused = false;
            try { legacy.InitializeAppleMeaning(new OpenMasuOptions(), configuration, completion); } catch (NotSupportedException) { refused = true; }
            Require(refused, "legacy implementer silently supported meanings");
            legacy.RecordAppleConversion("purchase", OpenMasuAppleConversionTarget.Install, _ => { });
        }
        Require(OpenMasuiOSPlatform.ActiveCallbackCount == 0, "meaning callback leaked");
    }

    // Transport-only fake: never implement a second evaluator or claim OS/SQLite evidence here.
    private sealed class SyntheticMeaningPlatform : IOpenMasuPlatform, IOpenMasuAppleMeaningPlatform
    {
        public OpenMasuAppleMeaningConfiguration Configuration;
        public string Operation, Event, Amount, Response;
        public OpenMasuAppleWindow Window;
        public bool Consent;
        public void InitializeAppleMeaning(OpenMasuOptions options, OpenMasuAppleMeaningConfiguration configuration, Action<string> completion) {
            Configuration = configuration; ThreadPool.QueueUserWorkItem(_ => completion("state=ready"));
        }
        public void RecordAppleMeaning(string operation, string eventKey, string amount, OpenMasuAppleWindow window, bool consent, Action<string> completion) {
            Operation = operation; Event = eventKey; Amount = amount; Window = window; Consent = consent;
            var response = Response; ThreadPool.QueueUserWorkItem(_ => completion(response));
        }
        public void Initialize(OpenMasuOptions options) { }
        public void TrackCustomEvent(string eventKey) { }
        public void StartSession() { }
        public void SetCollectionEnabled(bool value) { }
        public void ResetInstallationId(Action<bool> completion) => completion(true);
        public void PingFromBackground(string value, Action<string> completion) => completion(value);
        public void SetDeepLinkListener(Action<string> listener) { }
        public void HandleDeepLink(string value) { }
        public void Dispose() { }
    }
}
