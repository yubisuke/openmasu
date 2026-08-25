using OpenMmp.Unity;
using UnityEngine;

public sealed class OpenMmpSample : MonoBehaviour
{
    [SerializeField] private string endpoint = string.Empty;
    [SerializeField] private string sdkKeyId = string.Empty;
    [SerializeField] private string sdkSecret = string.Empty;

    private OpenMmpClient client;

    private void Start()
    {
#if UNITY_ANDROID && !UNITY_EDITOR
        client = new OpenMmpClient(new OpenMmpAndroidPlatform(), new OpenMmpDispatcher());
        client.Initialize(new OpenMmpOptions
        {
            Endpoint = endpoint,
            SdkKeyId = sdkKeyId,
            SdkSecret = sdkSecret,
            WrapperVersion = "unity-sample-0.1.0",
        });
        client.StartSession();
#else
        Debug.Log("Open MMP Android sample is active only in an Android player build.");
#endif
    }

    private void Update()
    {
        client?.PumpCallbacks();
    }

    public void TrackSyntheticEvent()
    {
        client?.TrackCustomEvent("unity_sample_action");
    }

    private void OnDestroy()
    {
        client?.Dispose();
    }
}
