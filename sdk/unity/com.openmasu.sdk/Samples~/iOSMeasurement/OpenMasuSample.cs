using OpenMasu.Unity;
using UnityEngine;

public sealed class OpenMasuIosSample : MonoBehaviour
{
    private OpenMasuClient client;

    private void Start()
    {
        client = new OpenMasuClient(new OpenMasuiOSPlatform(), new OpenMasuDispatcher());
        client.Initialize(new OpenMasuOptions
        {
            Endpoint = "https://synthetic.invalid",
            SdkKeyId = "sdk-key:replace-in-deployment",
            SdkSecret = "replace-in-deployment"
        });
        client.StartSession();
    }

    public void RecordSyntheticInstallConversion()
    {
        client?.RecordAppleConversion(
            "unity_sample_action",
            OpenMasuAppleConversionTarget.Install,
            updated => Debug.Log($"OpenMasu Apple conversion updated: {updated}"));
    }

    private void Update() => client?.PumpCallbacks();
    private void OnDestroy() => client?.Dispose();
}
