using System;
using OpenMasu.Unity;

/// <summary>Explicit host calls only. The accompanying bundle is a synthetic, date-bounded example.</summary>
public static class SyntheticAppleMeaningSample
{
    public static void Initialize(OpenMasuClient client, OpenMasuOptions options, string registeredBundle,
        Action<OpenMasuAppleMeaningResult> completion) =>
        client.InitializeAppleMeaning(options, OpenMasuAppleMeaningConfiguration.FromBundle(registeredBundle), completion);

    // 100 exact minor units at scale 2 in the example, not a floating-point dollar value.
    // Keep the operation key stable for retries; the host explicitly supplies consent and window.
    public static void RecordPurchase(OpenMasuClient client, string localOperationKey, OpenMasuAppleWindow window,
        bool consentGranted, Action<OpenMasuAppleMeaningResult> completion) =>
        client.RecordAppleMeaning(localOperationKey, "purchase", "100", window, consentGranted, completion);
}
