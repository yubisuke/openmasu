using System;
using OpenMasu.Unity;

// Call only against a disposable synthetic deployment. This is not a billing integration.
public static class SyntheticPurchaseSample
{
    public static void QueueGooglePlayProduct(OpenMasuClient client, Action<OpenMasuPurchaseResult> completion)
    {
        client.TrackGooglePlayProductPurchase(
            "synthetic-purchase-token", "synthetic.product", "transaction:synthetic", "1000", 2, "USD", completion);
    }

    public static void PrepareAppStore(OpenMasuClient client, Guid requestId, Action<OpenMasuPurchaseResult> completion)
    {
        // Keep this requestId for retries of this one preparation. A new purchase needs a new ID.
        client.PrepareAppStorePurchase("synthetic.product", requestId, true, completion);
    }

    public static void SubmitAppStore(OpenMasuClient client, OpenMasuPreparedAppStorePurchase prepared,
        Action<OpenMasuPurchaseResult> completion)
    {
        // Shape-only synthetic evidence: deliberately not an Apple-signed transaction.
        // A real integration supplies the host billing layer's protected JWS instead.
        client.SubmitAppStorePurchase(prepared, "syntheticHeader.syntheticPayload.syntheticSignature", true, completion);
    }
}
