using System;
using System.Threading;
using UnityEngine;

namespace OpenMmp.Unity
{
    public sealed class OpenMmpAndroidPlatform : IOpenMmpPlatform
    {
        private AndroidJavaClass bridge;
        private bool disposed;
        private static long activeAndroidObjects;

        public static long ActiveAndroidObjectCount => Interlocked.Read(ref activeAndroidObjects);

        public void Initialize(OpenMmpOptions options)
        {
            using (var activity = CurrentActivity())
            {
                EnsureBridge().CallStatic("initialize", activity, options.Endpoint, options.SdkKeyId, options.SdkSecret, options.WrapperVersion);
            }
        }

        public void TrackCustomEvent(string eventKey) => EnsureBridge().CallStatic("trackCustomEvent", eventKey);
        public void StartSession() => EnsureBridge().CallStatic("startSession");
        public void SetCollectionEnabled(bool enabled) => EnsureBridge().CallStatic("setCollectionEnabled", enabled);
        public void ResetInstallationId(Action<bool> completion) =>
            EnsureBridge().CallStatic("resetInstallationId", new BooleanCallback(completion));
        public void PingFromBackground(string value, Action<string> completion) =>
            EnsureBridge().CallStatic("pingFromBackground", value, new StringCallback(completion));

        private AndroidJavaClass EnsureBridge()
        {
            if (disposed) throw new ObjectDisposedException(nameof(OpenMmpAndroidPlatform));
            if (bridge != null) return bridge;
            Interlocked.Increment(ref activeAndroidObjects);
            bridge = new AndroidJavaClass("dev.openmmp.unity.OpenMmpUnityBridge");
            return bridge;
        }

        private static AndroidJavaObject CurrentActivity()
        {
            using (var player = new AndroidJavaClass("com.unity3d.player.UnityPlayer"))
            {
                return player.GetStatic<AndroidJavaObject>("currentActivity");
            }
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            if (bridge != null)
            {
                bridge.Dispose();
                bridge = null;
                Interlocked.Decrement(ref activeAndroidObjects);
            }
        }

        private sealed class StringCallback : AndroidJavaProxy
        {
            private readonly Action<string> callback;
            public StringCallback(Action<string> callback) : base("dev.openmmp.unity.OpenMmpUnityBridge$StringCallback") => this.callback = callback;
            public void onResult(string value)
            {
                AndroidJNI.AttachCurrentThread();
                callback(value);
            }
        }

        private sealed class BooleanCallback : AndroidJavaProxy
        {
            private readonly Action<bool> callback;
            public BooleanCallback(Action<bool> callback) : base("dev.openmmp.unity.OpenMmpUnityBridge$BooleanCallback") => this.callback = callback;
            public void onResult(bool value)
            {
                AndroidJNI.AttachCurrentThread();
                callback(value);
            }
        }
    }
}
