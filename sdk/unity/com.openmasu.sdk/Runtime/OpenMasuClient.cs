using System;
using System.Collections.Generic;
using System.Globalization;
using UnityEngine;

namespace OpenMasu.Unity
{
    [Flags]
    public enum OpenMasuAppleConversionTarget
    {
        Install = 1,
        Reengagement = 2,
    }

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

    public interface IOpenMasuDiagnosticsPlatform
    {
        void GetDiagnosticsSnapshot(Action<string> completion);
    }

    public interface IOpenMasuSyntheticValidationPlatform
    {
        void SetSyntheticValidationSession(string token, long expiresAtMs, Action<string> completion);
        void ClearSyntheticValidationSession(Action<string> completion);
    }

    public enum OpenMasuSyntheticValidationResult {
        Configured, Cleared, InvalidSession, Unsupported, NotInitialized, NativeFailure, PlatformUnavailable,
    }

    public enum OpenMasuDiagnosticOperation { None, Enrollment, Delivery, Deletion, DeletionStatus }
    public enum OpenMasuDiagnosticResult {
        NotAttempted, InFlight, Accepted, HttpResponse, AuthenticationRejected, RateLimited,
        NetworkUnavailable, ServerError, RequestRejected, UnexpectedResponse, CustomSuccess, CustomFailure,
    }
    public enum OpenMasuHttpClass { None, Http2xx, Http4xx, Http5xx, Other }
    public enum OpenMasuRetryState { None, Pending, CollectionBlocked, ConsentBlocked, ResetPending }

    /// <summary>Device-local state. Accepted means HTTP 202 admission, never ledger completion.</summary>
    public sealed class OpenMasuDiagnosticsSnapshot
    {
        public bool Available { get; private set; }
        public bool CollectionEnabled { get; private set; }
        public bool ConsentBarrierActive { get; private set; }
        public bool ResetPending { get; private set; }
        public bool Enrolled { get; private set; }
        public long? LastAttemptAtMs { get; private set; }
        public OpenMasuDiagnosticOperation LastOperation { get; private set; }
        public OpenMasuDiagnosticResult LastResult { get; private set; }
        public OpenMasuHttpClass HttpClass { get; private set; }
        public OpenMasuRetryState RetryState { get; private set; }
        public OpenMasuQueueHealth Queue { get; private set; }

        internal static OpenMasuDiagnosticsSnapshot Parse(string value)
        {
            var fields = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var pair in (value ?? string.Empty).Split('&'))
            {
                var parts = pair.Split(new[] { '=' }, 2);
                if (parts.Length != 2 || fields.ContainsKey(parts[0])) throw Invalid();
                fields.Add(parts[0], parts[1]);
            }
            if (fields.Count != 14) throw Invalid();
            var attempt = Field(fields, "last_attempt_at_ms");
            long? atMs = null;
            if (attempt.Length != 0)
            {
                if (!long.TryParse(attempt, NumberStyles.None, CultureInfo.InvariantCulture, out var number) || number < 0) throw Invalid();
                atMs = number;
            }
            return new OpenMasuDiagnosticsSnapshot {
                Available = Boolean(fields, "available"),
                CollectionEnabled = Boolean(fields, "collection_enabled"),
                ConsentBarrierActive = Boolean(fields, "consent_barrier_active"),
                ResetPending = Boolean(fields, "reset_pending"),
                Enrolled = Boolean(fields, "enrolled"),
                LastAttemptAtMs = atMs,
                LastOperation = ClosedEnum<OpenMasuDiagnosticOperation>(fields, "last_operation"),
                LastResult = ClosedEnum<OpenMasuDiagnosticResult>(fields, "last_result"),
                HttpClass = ClosedEnum<OpenMasuHttpClass>(fields, "http_class"),
                RetryState = ClosedEnum<OpenMasuRetryState>(fields, "retry_state"),
                Queue = OpenMasuQueueHealth.Parse(value),
            };
        }

        private static FormatException Invalid() => new FormatException("openmasu_diagnostics_invalid");
        private static string Field(IReadOnlyDictionary<string, string> fields, string key) =>
            fields.TryGetValue(key, out var value) ? value : throw Invalid();
        private static bool Boolean(IReadOnlyDictionary<string, string> fields, string key)
        {
            var value = Field(fields, key);
            if (value != "true" && value != "false") throw Invalid();
            return value == "true";
        }
        private static T ClosedEnum<T>(IReadOnlyDictionary<string, string> fields, string key) where T : struct
        {
            var value = Field(fields, key);
            if (value.Length == 0 || value[0] < 'a' || value[0] > 'z' ||
                !Enum.TryParse(value.Replace("_", string.Empty), true, out T result) || !Enum.IsDefined(typeof(T), result)) throw Invalid();
            return result;
        }
    }

    public interface IOpenMasuAppleConversionPlatform
    {
        void RecordAppleConversion(
            string eventName,
            OpenMasuAppleConversionTarget targets,
            string conversionTag,
            Action<bool> completion);
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
        public string WrapperVersion { get; set; } = "0.3.0-rc.3";
        public string[] DeepLinkHosts { get; set; } = Array.Empty<string>();
        public string[] DeepLinkSchemes { get; set; } = Array.Empty<string>();
        public bool EnablePlayReferrer { get; set; } = true;
        public string MetaAppId { get; set; } = string.Empty;
    }

    public sealed partial class OpenMasuClient : IDisposable
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

        public void Initialize(OpenMasuOptions options)
        {
            ResetAdRevenueContext();
            ChangeAdRevenueCollection(false);
            platform.Initialize(options);
        }
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
        public void RecordAppleConversion(
            string eventName,
            OpenMasuAppleConversionTarget targets,
            Action<bool> completion) =>
            RecordAppleConversion(eventName, targets, null, completion);
        public void RecordAppleConversion(
            string eventName,
            OpenMasuAppleConversionTarget targets,
            string conversionTag,
            Action<bool> completion)
        {
            if (!IsIdentifier(eventName))
                throw new ArgumentException("conversion_event_name_invalid", nameof(eventName));
            const OpenMasuAppleConversionTarget knownTargets =
                OpenMasuAppleConversionTarget.Install | OpenMasuAppleConversionTarget.Reengagement;
            if (targets == 0 || (targets & ~knownTargets) != 0)
                throw new ArgumentOutOfRangeException(nameof(targets), "conversion_targets_invalid");
            if (conversionTag != null &&
                (conversionTag.Length == 0 || targets != OpenMasuAppleConversionTarget.Reengagement))
                throw new ArgumentException("conversion_tag_requires_reengagement", nameof(conversionTag));
            if (completion == null) throw new ArgumentNullException(nameof(completion));
            AppleConversionPlatform().RecordAppleConversion(
                eventName,
                targets,
                conversionTag,
                value => dispatcher.Post(() => completion(value)));
        }
        public void GetQueueHealth(Action<OpenMasuQueueHealth> completion) =>
            QueueHealthPlatform().GetQueueHealth(value =>
                dispatcher.Post(() => completion(OpenMasuQueueHealth.Parse(value))));
        public void GetDiagnosticsSnapshot(Action<OpenMasuDiagnosticsSnapshot> completion)
        {
            if (completion == null) throw new ArgumentNullException(nameof(completion));
            var diagnostics = platform as IOpenMasuDiagnosticsPlatform;
            if (diagnostics == null) throw new NotSupportedException("openmasu_diagnostics_platform_unavailable");
            diagnostics.GetDiagnosticsSnapshot(value =>
                dispatcher.Post(() => completion(OpenMasuDiagnosticsSnapshot.Parse(value))));
        }
        public void SetCollectionEnabled(bool enabled)
        {
            ChangeAdRevenueCollection(enabled);
            platform.SetCollectionEnabled(enabled);
        }
        public void SetSyntheticValidationSession(string token, long expiresAtMs, Action<OpenMasuSyntheticValidationResult> completion)
        {
            if (completion == null) throw new ArgumentNullException(nameof(completion));
            SyntheticValidationPlatform().SetSyntheticValidationSession(token, expiresAtMs,
                value => dispatcher.Post(() => completion(ParseSyntheticValidationResult(value))));
        }
        public void ClearSyntheticValidationSession(Action<OpenMasuSyntheticValidationResult> completion)
        {
            if (completion == null) throw new ArgumentNullException(nameof(completion));
            SyntheticValidationPlatform().ClearSyntheticValidationSession(
                value => dispatcher.Post(() => completion(ParseSyntheticValidationResult(value))));
        }
        private IOpenMasuSyntheticValidationPlatform SyntheticValidationPlatform()
        {
            var value = platform as IOpenMasuSyntheticValidationPlatform;
            if (value == null) throw new NotSupportedException("openmasu_synthetic_validation_platform_unavailable");
            return value;
        }
        private static OpenMasuSyntheticValidationResult ParseSyntheticValidationResult(string value)
        {
            switch (value)
            {
                case "configured": return OpenMasuSyntheticValidationResult.Configured;
                case "cleared": return OpenMasuSyntheticValidationResult.Cleared;
                case "invalid_session": return OpenMasuSyntheticValidationResult.InvalidSession;
                case "unsupported": return OpenMasuSyntheticValidationResult.Unsupported;
                case "not_initialized": return OpenMasuSyntheticValidationResult.NotInitialized;
                case "platform_unavailable": return OpenMasuSyntheticValidationResult.PlatformUnavailable;
                default: return OpenMasuSyntheticValidationResult.NativeFailure;
            }
        }
        public void ResetInstallationId(Action<bool> completion)
        {
            ResetAdRevenueContext();
            platform.ResetInstallationId(value => dispatcher.Post(() => completion(value)));
        }
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

        private IOpenMasuAppleConversionPlatform AppleConversionPlatform()
        {
            var value = platform as IOpenMasuAppleConversionPlatform;
            if (value == null) throw new NotSupportedException("openmasu_apple_conversion_platform_unavailable");
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
            lock (adRevenueGate)
            {
                if (disposed) return;
                disposed = true;
                adRevenueEpoch++;
                adRevenueConsentEnabled = false;
            }
            if (unityDeepLinksAttached) Application.deepLinkActivated -= HandleDeepLink;
            platform.Dispose();
        }
    }

    public static class MaxRevenueSubscriptions
    {
        public static readonly IReadOnlyList<string> Formats = new[] { "Interstitial", "Rewarded", "Banner", "MRec" };
    }
}
