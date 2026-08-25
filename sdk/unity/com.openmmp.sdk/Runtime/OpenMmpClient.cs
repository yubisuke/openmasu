using System;
using System.Collections.Generic;

namespace OpenMmp.Unity
{
    public interface IOpenMmpPlatform : IDisposable
    {
        void Initialize(OpenMmpOptions options);
        void TrackCustomEvent(string eventKey);
        void StartSession();
        void SetCollectionEnabled(bool enabled);
        void ResetInstallationId(Action<bool> completion);
        void PingFromBackground(string value, Action<string> completion);
    }

    public sealed class OpenMmpOptions
    {
        public string Endpoint { get; set; } = string.Empty;
        public string SdkKeyId { get; set; } = string.Empty;
        public string SdkSecret { get; set; } = string.Empty;
        public string WrapperVersion { get; set; } = "0.1.0";
    }

    public sealed class OpenMmpClient : IDisposable
    {
        private readonly IOpenMmpPlatform platform;
        private readonly OpenMmpDispatcher dispatcher;
        private bool disposed;

        public OpenMmpClient(IOpenMmpPlatform platform, OpenMmpDispatcher dispatcher)
        {
            this.platform = platform ?? throw new ArgumentNullException(nameof(platform));
            this.dispatcher = dispatcher ?? throw new ArgumentNullException(nameof(dispatcher));
        }

        public void Initialize(OpenMmpOptions options) => platform.Initialize(options);
        public void TrackCustomEvent(string eventKey) => platform.TrackCustomEvent(eventKey);
        public void StartSession() => platform.StartSession();
        public void SetCollectionEnabled(bool enabled) => platform.SetCollectionEnabled(enabled);
        public void ResetInstallationId(Action<bool> completion) =>
            platform.ResetInstallationId(value => dispatcher.Post(() => completion(value)));
        public void PingFromBackground(string value, Action<string> completion) =>
            platform.PingFromBackground(value, result => dispatcher.Post(() => completion(result)));
        public int PumpCallbacks() => dispatcher.Pump();

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            platform.Dispose();
        }
    }

    public static class MaxRevenueSubscriptions
    {
        public static readonly IReadOnlyList<string> Formats = new[] { "Interstitial", "Rewarded", "Banner", "MRec" };
    }
}
