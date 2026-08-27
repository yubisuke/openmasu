using System;
using System.Collections.Generic;
using System.Globalization;
using UnityEngine;

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
        void SetDeepLinkListener(Action<string> listener);
        void HandleDeepLink(string url);
    }

    public interface IOpenMasuRevenuePlatform
    {
        void TrackPurchase(
            string transactionId,
            string amountUnscaled,
            int amountScale,
            string currency);
        void TrackRefund(
            string transactionId,
            string originalTransactionId,
            string amountUnscaled,
            int amountScale,
            string currency);
    }

    public interface IOpenMasuQueueHealthPlatform
    {
        void GetQueueHealth(Action<string> completion);
    }

    public sealed class OpenMasuQueueHealth
    {
        public int PendingCount { get; private set; }
        public long LogicalBytes { get; private set; }
        public long EvictedTotal { get; private set; }
        public long RejectedTotal { get; private set; }

        internal static OpenMasuQueueHealth Parse(string value)
        {
            var fields = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var pair in (value ?? string.Empty).Split('&'))
            {
                var parts = pair.Split(new[] { '=' }, 2);
                if (parts.Length == 2) fields[parts[0]] = parts[1];
            }
            return new OpenMasuQueueHealth {
                PendingCount = ParseInt(fields, "pending_count"),
                LogicalBytes = ParseLong(fields, "logical_bytes"),
                EvictedTotal = ParseLong(fields, "evicted_total"),
                RejectedTotal = ParseLong(fields, "rejected_total"),
            };
        }

        private static int ParseInt(IReadOnlyDictionary<string, string> fields, string key) =>
            checked((int)ParseLong(fields, key));

        private static long ParseLong(IReadOnlyDictionary<string, string> fields, string key)
        {
            if (!fields.TryGetValue(key, out var value) ||
                !long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var result) || result < 0)
                throw new FormatException("openmasu_queue_health_invalid");
            return result;
        }
    }

    public sealed class OpenMasuDeepLink
    {
        public string Value { get; private set; }
        public string OpenSource { get; private set; }
        public string DestinationStatus { get; private set; }
        public string LinkSlug { get; private set; }
        public IReadOnlyDictionary<string, string> Parameters { get; private set; }

        internal static OpenMasuDeepLink Parse(string value)
        {
            var fields = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var pair in (value ?? string.Empty).Split('&'))
            {
                var parts = pair.Split(new[] { '=' }, 2);
                if (parts.Length == 2) fields[Uri.UnescapeDataString(parts[0])] = Uri.UnescapeDataString(parts[1]);
            }
            var parameters = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var field in fields)
                if (field.Key.StartsWith("p_", StringComparison.Ordinal)) parameters[field.Key.Substring(2)] = field.Value;
            return new OpenMasuDeepLink {
                Value = fields.TryGetValue("value", out var destination) ? destination : null,
                OpenSource = fields.TryGetValue("open_source", out var source) ? source : string.Empty,
                DestinationStatus = fields.TryGetValue("destination_status", out var status) ? status : string.Empty,
                LinkSlug = fields.TryGetValue("link_slug", out var slug) ? slug : null,
                Parameters = parameters,
            };
        }
    }

    public sealed class OpenMasuOptions
    {
        public string Endpoint { get; set; } = string.Empty;
        public string SdkKeyId { get; set; } = string.Empty;
        public string SdkSecret { get; set; } = string.Empty;
        public string WrapperVersion { get; set; } = "0.2.0-rc.3";
        public string[] DeepLinkHosts { get; set; } = Array.Empty<string>();
        public string[] DeepLinkSchemes { get; set; } = Array.Empty<string>();
        public bool EnablePlayReferrer { get; set; } = true;
        public string MetaAppId { get; set; } = string.Empty;
    }

    public sealed class OpenMasuClient : IDisposable
    {
        private readonly IOpenMasuPlatform platform;
        private readonly OpenMasuDispatcher dispatcher;
        private bool disposed;
        private bool unityDeepLinksAttached;

        public OpenMasuClient(IOpenMasuPlatform platform, OpenMasuDispatcher dispatcher)
        {
            this.platform = platform ?? throw new ArgumentNullException(nameof(platform));
            this.dispatcher = dispatcher ?? throw new ArgumentNullException(nameof(dispatcher));
        }

        public void Initialize(OpenMasuOptions options) => platform.Initialize(options);
        public void TrackCustomEvent(string eventKey) => platform.TrackCustomEvent(eventKey);
        public void TrackPurchase(
            string transactionId,
            string amountUnscaled,
            int amountScale,
            string currency)
        {
            ValidateCommerceEvent(transactionId, amountUnscaled, amountScale, currency);
            RevenuePlatform().TrackPurchase(transactionId, amountUnscaled, amountScale, currency);
        }
        public void TrackRefund(
            string transactionId,
            string originalTransactionId,
            string amountUnscaled,
            int amountScale,
            string currency)
        {
            ValidateCommerceEvent(transactionId, amountUnscaled, amountScale, currency);
            if (!IsIdentifier(originalTransactionId))
                throw new ArgumentException("original_transaction_id_invalid", nameof(originalTransactionId));
            RevenuePlatform().TrackRefund(transactionId, originalTransactionId, amountUnscaled, amountScale, currency);
        }
        public void StartSession() => platform.StartSession();
        public void GetQueueHealth(Action<OpenMasuQueueHealth> completion) =>
            QueueHealthPlatform().GetQueueHealth(value =>
                dispatcher.Post(() => completion(OpenMasuQueueHealth.Parse(value))));
        public void SetCollectionEnabled(bool enabled) => platform.SetCollectionEnabled(enabled);
        public void ResetInstallationId(Action<bool> completion) =>
            platform.ResetInstallationId(value => dispatcher.Post(() => completion(value)));
        public void PingFromBackground(string value, Action<string> completion) =>
            platform.PingFromBackground(value, result => dispatcher.Post(() => completion(result)));
        public void SetDeepLinkListener(Action<OpenMasuDeepLink> listener) =>
            platform.SetDeepLinkListener(result => dispatcher.Post(() => listener(OpenMasuDeepLink.Parse(result))));
        public void HandleDeepLink(string url) => platform.HandleDeepLink(url);
        public void AttachUnityDeepLinkForwarding()
        {
            if (unityDeepLinksAttached) return;
            unityDeepLinksAttached = true;
            Application.deepLinkActivated += HandleDeepLink;
            if (!string.IsNullOrEmpty(Application.absoluteURL)) HandleDeepLink(Application.absoluteURL);
        }
        public int PumpCallbacks() => dispatcher.Pump();

        private IOpenMasuRevenuePlatform RevenuePlatform()
        {
            var value = platform as IOpenMasuRevenuePlatform;
            if (value == null) throw new NotSupportedException("openmasu_revenue_platform_unavailable");
            return value;
        }

        private IOpenMasuQueueHealthPlatform QueueHealthPlatform()
        {
            var value = platform as IOpenMasuQueueHealthPlatform;
            if (value == null) throw new NotSupportedException("openmasu_queue_health_platform_unavailable");
            return value;
        }

        private static void ValidateCommerceEvent(
            string transactionId,
            string amountUnscaled,
            int amountScale,
            string currency)
        {
            if (!IsIdentifier(transactionId))
                throw new ArgumentException("transaction_id_invalid", nameof(transactionId));
            if (string.IsNullOrEmpty(amountUnscaled))
                throw new ArgumentException("amount_unscaled_invalid", nameof(amountUnscaled));
            foreach (var character in amountUnscaled)
                if (character < '0' || character > '9')
                    throw new ArgumentException("amount_unscaled_invalid", nameof(amountUnscaled));
            if (amountScale < 0 || amountScale > 18)
                throw new ArgumentOutOfRangeException(nameof(amountScale), "amount_scale_invalid");
            if (currency == null || currency.Length != 3 ||
                currency[0] < 'A' || currency[0] > 'Z' ||
                currency[1] < 'A' || currency[1] > 'Z' ||
                currency[2] < 'A' || currency[2] > 'Z')
                throw new ArgumentException("currency_invalid", nameof(currency));
        }

        private static bool IsIdentifier(string value)
        {
            if (string.IsNullOrEmpty(value) || value.Length > 128) return false;
            foreach (var character in value)
            {
                if ((character >= 'A' && character <= 'Z') ||
                    (character >= 'a' && character <= 'z') ||
                    (character >= '0' && character <= '9') ||
                    character == '.' || character == '_' || character == ':' || character == '-') continue;
                return false;
            }
            return true;
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            if (unityDeepLinksAttached) Application.deepLinkActivated -= HandleDeepLink;
            platform.Dispose();
        }
    }

    public static class MaxRevenueSubscriptions
    {
        public static readonly IReadOnlyList<string> Formats = new[] { "Interstitial", "Rewarded", "Banner", "MRec" };
    }
}
