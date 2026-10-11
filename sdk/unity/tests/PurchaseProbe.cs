using System;
using System.Threading;
using OpenMasu.Unity;

internal static partial class Program
{
    private static void ExerciseProtectedPurchases(int mainThread)
    {
        using (var legacy = new OpenMasuClient(new SyntheticRevenuePlatform(), new OpenMasuDispatcher()))
        {
            var unsupported = false;
            try { legacy.PrepareAppStorePurchase("synthetic.product", Guid.NewGuid(), true, _ => { }); }
            catch (NotSupportedException) { unsupported = true; }
            Require(unsupported, "legacy purchase platform silently supported store verification");
            legacy.TrackPurchase("transaction:synthetic", "1000", 2, "USD");
        }
        var platform = new SyntheticPurchasePlatform();
        var dispatcher = new OpenMasuDispatcher();
        var client = new OpenMasuClient(platform, dispatcher);
        var callbackCount = 0;
        OpenMasuPurchaseResult result = null;
        Action<OpenMasuPurchaseResult> completion = value => {
            Require(Environment.CurrentManagedThreadId == mainThread, "purchase callback left the Unity thread");
            callbackCount++;
            result = value;
        };
        var requestId = Guid.Parse("00000000-0000-4000-8000-000000000239");
        SyntheticPurchaseSample.PrepareAppStore(client, requestId, completion);
        Require(platform.RequestId == requestId.ToString("D"), "prepare retry identity changed");
        const string prepared = "state=prepared&prepared=e30%3D&app_account_token=00000000-0000-4000-8000-000000000240";
        var callback = platform.Completion;
        var thread = new Thread(() => { callback(prepared); callback(prepared); });
        thread.Start(); thread.Join();
        Require(callbackCount == 0, "purchase callback ran before PumpCallbacks");
        client.PumpCallbacks();
        Require(callbackCount == 1 && result.State == OpenMasuPurchaseState.Prepared, "prepare callback not exactly once");
        var purchase = result.PreparedPurchase;
        Require(purchase.AppAccountToken == Guid.Parse("00000000-0000-4000-8000-000000000240"), "app account token changed");
        Require(!purchase.ToString().Contains("e30"), "prepared purchase leaked in ToString");
        for (var attempt = 0; attempt < 2; attempt++)
        {
            client.SubmitAppStorePurchase(purchase, "synthetic.header.signature", true, completion);
            Require(platform.Prepared == "e30=" && platform.SignedTransaction == "synthetic.header.signature",
                "submit retry did not preserve prepared identity or protected payload");
            platform.Completion("state=pending"); client.PumpCallbacks();
            Require(result.State == OpenMasuPurchaseState.Pending, "pending became verified");
        }
        SyntheticPurchaseSample.QueueGooglePlayProduct(client, completion);
        platform.Completion("state=queued"); client.PumpCallbacks();
        Require(result.State == OpenMasuPurchaseState.Queued && !platform.Subscription, "product enqueue state changed");
        client.TrackGooglePlaySubscriptionPurchase("synthetic-token", "synthetic.product", "transaction:synthetic", "1000", 2, "USD", completion);
        platform.Completion("state=not_submitted&error=consent_required"); client.PumpCallbacks();
        Require(result.State == OpenMasuPurchaseState.NotSubmitted && platform.Subscription,
            "blocked subscription was shown as queued");
        bool? consentUpdated = null;
        client.UpdateConsent(OpenMasuConsentState.Withdrawn, "policy:synthetic", value => consentUpdated = value);
        Require(platform.ConsentState == "withdrawn", "consent was not forwarded to native");
        platform.Completion("state=updated"); client.PumpCallbacks();
        Require(consentUpdated == true, "consent acknowledgement was lost");
        client.SubmitAppStorePurchase(purchase, "synthetic.header.signature", true, completion);
        platform.Completion("state=not_submitted&error=purchase_context_changed"); client.PumpCallbacks();
        Require(result.State == OpenMasuPurchaseState.NotSubmitted, "changed installation context became pending");
        client.PrepareAppStorePurchase("synthetic.product", requestId, true, completion);
        platform.Completion("state=verified"); client.PumpCallbacks();
        Require(result.State == OpenMasuPurchaseState.NotSubmitted, "bridge invented a verified state");
        var beforeDispose = callbackCount;
        client.PrepareAppStorePurchase("synthetic.product", requestId, true, completion);
        platform.Completion(prepared);
        client.Dispose(); client.PumpCallbacks();
        Require(callbackCount == beforeDispose, "disposed client delivered a pending purchase callback");

        using (var ios = new OpenMasuiOSPlatform())
        using (var editor = new OpenMasuClient(ios, new OpenMasuDispatcher()))
        {
            OpenMasuPurchaseResult unavailable = null;
            editor.PrepareAppStorePurchase("synthetic.product", requestId, true, value => unavailable = value);
            var deadline = DateTime.UtcNow.AddSeconds(5);
            while (unavailable == null && DateTime.UtcNow < deadline) { editor.PumpCallbacks(); Thread.Yield(); }
            Require(unavailable?.State == OpenMasuPurchaseState.NotSubmitted, "Editor reported real-store preparation");
        }
        Require(OpenMasuiOSPlatform.ActiveCallbackCount == 0, "purchase callback leaked");
        Console.WriteLine("Protected purchase bridge passed: optional compatibility, prepare/retry, pending/queued/refused, consent, main-thread single callback, disposal.");
    }

    private sealed class SyntheticPurchasePlatform : IOpenMasuPlatform, IOpenMasuAppStorePurchasePlatform,
        IOpenMasuGooglePlayPurchasePlatform, IOpenMasuConsentPlatform
    {
        public Action<string> Completion;
        public string RequestId, Prepared, SignedTransaction, ConsentState;
        public bool Subscription;
        public void PrepareAppStorePurchase(string productId, string requestId, bool consent, Action<string> completion)
        { RequestId = requestId; Completion = completion; }
        public void SubmitAppStorePurchase(string prepared, string signedTransaction, bool consent, Action<string> completion)
        { Prepared = prepared; SignedTransaction = signedTransaction; Completion = completion; }
        public void TrackGooglePlayProductPurchase(string token, string productId, string transactionId, string amount, int scale, string currency, Action<string> completion)
        { Subscription = false; Completion = completion; }
        public void TrackGooglePlaySubscriptionPurchase(string token, string productId, string transactionId, string amount, int scale, string currency, Action<string> completion)
        { Subscription = true; Completion = completion; }
        public void UpdateConsent(string state, string policy, Action<string> completion)
        { ConsentState = state; Completion = completion; }
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
