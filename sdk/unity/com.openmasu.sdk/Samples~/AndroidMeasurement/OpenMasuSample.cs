using OpenMasu.Unity;
using UnityEngine;

public sealed class OpenMasuSample : MonoBehaviour
{
    [SerializeField] private string endpoint = string.Empty;
    [SerializeField] private string sdkKeyId = string.Empty;
    [SerializeField] private string sdkSecret = string.Empty;

    private OpenMasuClient client;

    private void Start()
    {
#if UNITY_ANDROID && !UNITY_EDITOR
        client = new OpenMasuClient(new OpenMasuAndroidPlatform(), new OpenMasuDispatcher());
        client.Initialize(new OpenMasuOptions
        {
            Endpoint = endpoint,
            SdkKeyId = sdkKeyId,
            SdkSecret = sdkSecret,
            WrapperVersion = "unity-sample-0.1.0",
        });
        client.StartSession();
#else
        Debug.Log("OpenMasu Android sample is active only in an Android player build.");
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
