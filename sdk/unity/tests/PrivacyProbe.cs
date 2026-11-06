using System;
using OpenMasu.Unity;

internal static partial class Program
{
    private static void ExercisePrivacyPages()
    {
        using (var platform = new SyntheticPrivacyPlatform())
        using (var client = new OpenMasuClient(platform, new OpenMasuDispatcher(32)))
        {
            foreach (var type in new[] { OpenMasuPrivacyRequestType.Access, OpenMasuPrivacyRequestType.Portability })
            {
                OpenMasuPrivacyResult result = null;
                client.RequestPrivacyPage(type, value => result = value, pageSize: 2);
                Require(result == null, "privacy callback bypassed Unity dispatcher");
                client.PumpCallbacks();
                Require(result.Status == OpenMasuPrivacyStatus.PageReady && !result.Page.Complete, "partial privacy page claimed completion");
                Require(result.Page.ToString() == "OpenMasuPrivacyPage(redacted)", "privacy ToString exposed payload");
                client.RequestPrivacyPage(type, value => result = value, cursor: result.Page.NextCursor, pageSize: 2);
                client.PumpCallbacks();
                Require(result.Status == OpenMasuPrivacyStatus.Complete && result.Page.NextCursor == null, "last privacy page did not complete");
                Require(platform.EventCalls == 0, "privacy page entered measurement path");
            }
            OpenMasuPrivacyResult stale = null;
            client.RequestPrivacyPage(OpenMasuPrivacyRequestType.Access, value => stale = value, pageSize: 2);
            client.ResetInstallationId(_ => { });
            client.PumpCallbacks();
            Require(stale.Status == OpenMasuPrivacyStatus.ContextChanged && stale.Page == null, "queued old-installation response escaped reset");
            client.RequestPrivacyPage(OpenMasuPrivacyRequestType.Access, value => stale = value, cursor: "!");
            client.PumpCallbacks();
            Require(stale.Status == OpenMasuPrivacyStatus.InvalidRequest, "invalid privacy cursor accepted");
            platform.Fail = true;
            client.RequestPrivacyPage(OpenMasuPrivacyRequestType.Access, value => stale = value);
            client.PumpCallbacks();
            Require(stale.Status == OpenMasuPrivacyStatus.RequestFailed && stale.Page == null, "failure became completion");
        }
        using (var platform = new SyntheticPlatform())
        using (var client = new OpenMasuClient(platform, new OpenMasuDispatcher(8)))
        {
            OpenMasuPrivacyResult result = null;
            client.RequestPrivacyPage(OpenMasuPrivacyRequestType.Access, value => result = value);
            client.PumpCallbacks();
            Require(result.Status == OpenMasuPrivacyStatus.Unsupported, "legacy platform compatibility changed");
        }
        using (var platform = new OpenMasuiOSPlatform())
        using (var client = new OpenMasuClient(platform, new OpenMasuDispatcher(8)))
        {
            OpenMasuPrivacyResult result = null;
            client.RequestPrivacyPage(OpenMasuPrivacyRequestType.Access, value => result = value);
            var deadline = DateTime.UtcNow.AddSeconds(5);
            while (result == null && DateTime.UtcNow < deadline) { client.PumpCallbacks(); System.Threading.Thread.Yield(); }
            Require(result != null && result.Status == OpenMasuPrivacyStatus.Unsupported && OpenMasuiOSPlatform.ActiveCallbackCount == 0,
                "Editor claimed native export or leaked callback");
        }
        Console.WriteLine("Privacy page probe passed: partial/final, access/portability, reset, failure, legacy transport, no measurement side effects.");
    }

    private sealed class SyntheticPrivacyPlatform : IOpenMasuPlatform, IOpenMasuPrivacyPlatform
    {
        public int EventCalls;
        public bool Fail;
        public void RequestPrivacyPage(string requestType, string cursor, int pageSize, Action<string> completion)
        {
            if (Fail) { completion("request_failed\n"); return; }
            var complete = cursor != null;
            completion((complete ? "complete" : "page_ready") + "\n" +
                "{\"dsar_response_version\":\"internal-v2\",\"request_type\":\"" + requestType +
                "\",\"request_id\":\"synthetic-export\",\"cutoff_at\":\"2026-11-01T00:00:00.000Z\",\"returned_count\":0,\"page_size\":" + pageSize +
                ",\"complete\":" + (complete ? "true" : "false") + ",\"next_cursor\":" + (complete ? "null" : "\"synthetic_cursor\"") +
                ",\"records\":[],\"attributions\":[],\"verified_commerce_lifecycle\":[]}");
        }
        public void Initialize(OpenMasuOptions options) { }
        public void TrackCustomEvent(string eventKey) { EventCalls++; }
        public void StartSession() { EventCalls++; }
        public void SetCollectionEnabled(bool enabled) { }
        public void ResetInstallationId(Action<bool> completion) { completion(true); }
        public void PingFromBackground(string value, Action<string> completion) { completion(value); }
        public void SetDeepLinkListener(Action<string> listener) { }
        public void HandleDeepLink(string url) { }
        public void Dispose() { }
    }
}
