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

    private void Update() => client?.PumpCallbacks();
    private void OnDestroy() => client?.Dispose();
}
