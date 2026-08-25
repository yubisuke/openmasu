using System;
using System.Collections.Generic;

namespace OpenMasu.Unity
{
    public interface IOpenMasuPlatform : IDisposable
    {
        void Initialize(OpenMasuOptions options);
        void TrackCustomEvent(string eventKey);
        void StartSession();
        void SetCollectionEnabled(bool enabled);
        void ResetInstallationId(Action<bool> completion);
        void PingFromBackground(string value, Action<string> completion);
    }

    public sealed class OpenMasuOptions
    {
        public string Endpoint { get; set; } = string.Empty;
        public string SdkKeyId { get; set; } = string.Empty;
        public string SdkSecret { get; set; } = string.Empty;
        public string WrapperVersion { get; set; } = "0.1.0";
    }

    public sealed class OpenMasuClient : IDisposable
    {
        private readonly IOpenMasuPlatform platform;
        private readonly OpenMasuDispatcher dispatcher;
        private bool disposed;

        public OpenMasuClient(IOpenMasuPlatform platform, OpenMasuDispatcher dispatcher)
        {
            this.platform = platform ?? throw new ArgumentNullException(nameof(platform));
            this.dispatcher = dispatcher ?? throw new ArgumentNullException(nameof(dispatcher));
        }

        public void Initialize(OpenMasuOptions options) => platform.Initialize(options);
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
