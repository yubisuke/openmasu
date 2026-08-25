using OpenMmp.Unity;
using UnityEngine;

public sealed class OpenMmpIosSample : MonoBehaviour
{
    private OpenMmpClient client;

    private void Start()
    {
        client = new OpenMmpClient(new OpenMmpiOSPlatform(), new OpenMmpDispatcher());
        client.Initialize(new OpenMmpOptions
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
