using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Threading;
using AOT;

namespace OpenMasu.Unity
{
    public sealed class OpenMasuiOSPlatform : IOpenMasuPlatform, IOpenMasuRevenuePlatform, IOpenMasuQueueHealthPlatform, IOpenMasuAppleConversionPlatform
    {
        private delegate void NativeCallback(long requestId, IntPtr value);
        private static readonly NativeCallback Callback = OnNativeCallback;
        private static readonly ConcurrentDictionary<long, Action<string>> Callbacks =
            new ConcurrentDictionary<long, Action<string>>();
        private static long nextRequestId;
        private bool disposed;
        private Action<string> deepLinkListener;

        public static int ActiveCallbackCount => Callbacks.Count;

        public void Initialize(OpenMasuOptions options)
        {
            ThrowIfDisposed();
            var requestId = Register(_ => { });
#if UNITY_IOS && !UNITY_EDITOR
            openmasu_ios_initialize(options.Endpoint, options.SdkKeyId, options.SdkSecret, requestId, Callback);
#else
            CompleteSynthetic(requestId, "ok");
#endif
        }

        public void TrackCustomEvent(string eventKey)
        {
            ThrowIfDisposed();
            var requestId = Register(_ => { });
#if UNITY_IOS && !UNITY_EDITOR
            openmasu_ios_track_custom_event(eventKey, requestId, Callback);
#else
            CompleteSynthetic(requestId, "ok");
#endif
        }

        public void RecordAppleConversion(
            string eventName,
            OpenMasuAppleConversionTarget targets,
            string conversionTag,
            Action<bool> completion)
        {
            ThrowIfDisposed();
            var requestId = Register(value => completion(value == "ok"));
#if UNITY_IOS && !UNITY_EDITOR
            openmasu_ios_record_conversion(eventName, (int)targets, conversionTag, requestId, Callback);
#else
            CompleteSynthetic(requestId, "ok");
#endif
        }

        public void TrackPurchase(
            string transactionId,
            string amountUnscaled,
            int amountScale,
            string currency)
        {
            ThrowIfDisposed();
            var requestId = Register(_ => { });
#if UNITY_IOS && !UNITY_EDITOR
            openmasu_ios_track_purchase(transactionId, amountUnscaled, amountScale, currency, requestId, Callback);
#else
            CompleteSynthetic(requestId, "ok");
#endif
        }

        public void TrackRefund(
            string transactionId,
            string originalTransactionId,
            string amountUnscaled,
            int amountScale,
            string currency)
        {
            ThrowIfDisposed();
            var requestId = Register(_ => { });
#if UNITY_IOS && !UNITY_EDITOR
            openmasu_ios_track_refund(
                transactionId, originalTransactionId, amountUnscaled, amountScale, currency, requestId, Callback);
#else
            CompleteSynthetic(requestId, "ok");
#endif
        }

        public static void TrackMaxRevenue(
            double revenue,
            string precision,
            string networkName,
            string adUnitId,
            string format,
            string placement,
            string networkPlacement,
            Action<bool> completion)
        {
            var requestId = Register(value => completion(value == "ok"));
#if UNITY_IOS && !UNITY_EDITOR
            openmasu_ios_track_max_revenue(
                revenue, precision, networkName, adUnitId, format, placement, networkPlacement, requestId, Callback);
#else
            CompleteSynthetic(requestId, "ok");
#endif
        }

        public void StartSession()
        {
            ThrowIfDisposed();
            var requestId = Register(_ => { });
#if UNITY_IOS && !UNITY_EDITOR
            openmasu_ios_start_session(requestId, Callback);
#else
            CompleteSynthetic(requestId, "ok");
#endif
        }

        public void GetQueueHealth(Action<string> completion)
        {
            ThrowIfDisposed();
            var requestId = Register(completion);
#if UNITY_IOS && !UNITY_EDITOR
            openmasu_ios_queue_health(requestId, Callback);
#else
            CompleteSynthetic(requestId, "pending_count=0&logical_bytes=0&evicted_total=0&rejected_total=0");
#endif
        }

        public void SetCollectionEnabled(bool enabled)
        {
            ThrowIfDisposed();
#if UNITY_IOS && !UNITY_EDITOR
            openmasu_ios_set_collection_enabled(enabled);
#endif
        }

        public void ResetInstallationId(Action<bool> completion)
        {
            ThrowIfDisposed();
            var requestId = Register(value => completion(value == "ok"));
#if UNITY_IOS && !UNITY_EDITOR
            openmasu_ios_reset_installation(requestId, Callback);
#else
            CompleteSynthetic(requestId, "ok");
#endif
        }

        public void PingFromBackground(string value, Action<string> completion)
        {
            ThrowIfDisposed();
            var requestId = Register(completion);
#if UNITY_IOS && !UNITY_EDITOR
            openmasu_ios_ping_from_background(value, requestId, Callback);
#else
            CompleteSynthetic(requestId, value);
#endif
        }

        public void SetDeepLinkListener(Action<string> listener) { ThrowIfDisposed(); deepLinkListener = listener; }

        public void HandleDeepLink(string url)
        {
            ThrowIfDisposed();
            var requestId = Register(value => { if (!value.StartsWith("error:", StringComparison.Ordinal)) deepLinkListener?.Invoke(value); });
#if UNITY_IOS && !UNITY_EDITOR
            openmasu_ios_handle_deep_link(url, requestId, Callback);
#else
            CompleteSynthetic(requestId, "value=%2Fsynthetic&open_source=ios_universal_link&destination_status=delivered&link_slug=Synthetic123");
#endif
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
        }

        private static long Register(Action<string> completion)
        {
            var requestId = Interlocked.Increment(ref nextRequestId);
            if (!Callbacks.TryAdd(requestId, completion)) throw new InvalidOperationException("callback_id_collision");
            return requestId;
        }

        private static void CompleteSynthetic(long requestId, string value) =>
            ThreadPool.QueueUserWorkItem(_ => Complete(requestId, value));

        [MonoPInvokeCallback(typeof(NativeCallback))]
        private static void OnNativeCallback(long requestId, IntPtr value)
        {
            var text = value == IntPtr.Zero ? string.Empty : Marshal.PtrToStringUTF8(value) ?? string.Empty;
            Complete(requestId, text);
        }

        private static void Complete(long requestId, string value)
        {
            if (Callbacks.TryRemove(requestId, out var completion)) completion(value);
        }

        private void ThrowIfDisposed()
        {
            if (disposed) throw new ObjectDisposedException(nameof(OpenMasuiOSPlatform));
        }

#if UNITY_IOS && !UNITY_EDITOR
        [DllImport("__Internal")]
        private static extern void openmasu_ios_initialize(
            string endpoint, string sdkKeyId, string sdkSecret, long requestId, NativeCallback callback);
        [DllImport("__Internal")]
        private static extern void openmasu_ios_track_custom_event(string eventKey, long requestId, NativeCallback callback);
        [DllImport("__Internal")]
        private static extern void openmasu_ios_record_conversion(
            string eventName,
            int targetMask,
            string conversionTag,
            long requestId,
            NativeCallback callback);
        [DllImport("__Internal")]
        private static extern void openmasu_ios_track_purchase(
            string transactionId,
            string amountUnscaled,
            int amountScale,
            string currency,
            long requestId,
            NativeCallback callback);
        [DllImport("__Internal")]
        private static extern void openmasu_ios_track_refund(
            string transactionId,
            string originalTransactionId,
            string amountUnscaled,
            int amountScale,
            string currency,
            long requestId,
            NativeCallback callback);
        [DllImport("__Internal")]
        private static extern void openmasu_ios_track_max_revenue(
            double revenue,
            string precision,
            string networkName,
            string adUnitId,
            string format,
            string placement,
            string networkPlacement,
            long requestId,
            NativeCallback callback);
        [DllImport("__Internal")]
        private static extern void openmasu_ios_start_session(long requestId, NativeCallback callback);
        [DllImport("__Internal")]
        private static extern void openmasu_ios_queue_health(long requestId, NativeCallback callback);
        [DllImport("__Internal")]
        private static extern void openmasu_ios_set_collection_enabled([MarshalAs(UnmanagedType.I1)] bool enabled);
        [DllImport("__Internal")]
        private static extern void openmasu_ios_reset_installation(long requestId, NativeCallback callback);
        [DllImport("__Internal")]
        private static extern void openmasu_ios_ping_from_background(string value, long requestId, NativeCallback callback);
        [DllImport("__Internal")]
        private static extern void openmasu_ios_handle_deep_link(string url, long requestId, NativeCallback callback);
#endif
    }
}
