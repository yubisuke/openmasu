using System;

namespace AOT
{
    [AttributeUsage(AttributeTargets.Method)]
    public sealed class MonoPInvokeCallbackAttribute : Attribute
    {
        public MonoPInvokeCallbackAttribute(Type delegateType) { }
    }
}

namespace UnityEngine
{
    public static class JsonUtility
    {
        public static T FromJson<T>(string json) => default(T);
    }

    public class AndroidJavaObject : IDisposable
    {
        public void Dispose() { }
        public T Call<T>(string method, params object[] args) => default(T);
        public void Call(string method, params object[] args) { }
    }
    public class AndroidJavaClass : AndroidJavaObject
    {
        public AndroidJavaClass(string name) { }
        public T GetStatic<T>(string name) => default(T);
        public void CallStatic(string method, params object[] args) { }
    }
    public class AndroidJavaProxy
    {
        protected AndroidJavaProxy(string interfaceName) { }
    }
    public static class AndroidJNI
    {
        public static int AttachCurrentThread() => 0;
    }
    public static class Application
    {
        public static string absoluteURL = string.Empty;
        public static event Action<string> deepLinkActivated;
        public static void RaiseDeepLink(string value) => deepLinkActivated?.Invoke(value);
    }
}

namespace UnityEditor.Android
{
    public interface IPostGenerateGradleAndroidProject
    {
        int callbackOrder { get; }
        void OnPostGenerateGradleAndroidProject(string projectPath);
    }
}

namespace UnityEditor.Build
{
    public sealed class BuildFailedException : Exception
    {
        public BuildFailedException(string message) : base(message) { }
    }
}

public static class MaxSdk
{
    public sealed class AdInfo
    {
        public double Revenue { get; set; }
        public string RevenuePrecision { get; set; }
        public string NetworkName { get; set; }
        public string AdUnitIdentifier { get; set; }
        public string Placement { get; set; }
        public string NetworkPlacement { get; set; }
    }
}

public static class MaxSdkCallbacks
{
    public delegate void RevenuePaid(string adUnitId, MaxSdk.AdInfo adInfo);

    public static class Interstitial { public static event RevenuePaid OnAdRevenuePaidEvent; }
    public static class Rewarded { public static event RevenuePaid OnAdRevenuePaidEvent; }
    public static class Banner { public static event RevenuePaid OnAdRevenuePaidEvent; }
    public static class MRec { public static event RevenuePaid OnAdRevenuePaidEvent; }
}
