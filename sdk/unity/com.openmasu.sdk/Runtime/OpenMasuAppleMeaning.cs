using System;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using UnityEngine;

namespace OpenMasu.Unity
{
    public enum OpenMasuAppleWindow { First = 0, Second = 1, Third = 2 }
    public enum OpenMasuAppleCoarseValue { Low, Medium, High }
    public enum OpenMasuAppleMeaningState { Ready, Updated, NotApplied }
    public enum OpenMasuAppleMeaningError {
        None, InvalidDefinition, DigestMismatch, InvalidSignal, InvalidRevenue, EventConflict,
        ConsentRequired, ContextChanged, ContextBusy, StateLimit, CollectionDisabled,
        NotInitialized, UpdateFailed, PlatformUnavailable,
    }

    /// <summary>Immutable registered definition. No remote lookup or inferred latest version.</summary>
    public sealed class OpenMasuAppleMeaningConfiguration
    {
        public string CanonicalDefinition { get; }
        public string SchemaVersion { get; }
        public string SchemaDigest { get; }

        public OpenMasuAppleMeaningConfiguration(string canonicalDefinition, string schemaVersion, string schemaDigest)
        {
            if (canonicalDefinition == null || Encoding.UTF8.GetByteCount(canonicalDefinition) > 32768 ||
                !Regex.IsMatch(schemaVersion ?? "", @"\A[0-9]+\.[0-9]+\.[0-9]+\z") || schemaVersion.Length > 128 ||
                !Regex.IsMatch(schemaDigest ?? "", @"\A[a-f0-9]{64}\z"))
                throw new ArgumentException("conversion_meaning_configuration_invalid");
            using (var hash = SHA256.Create())
            {
                var actual = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(canonicalDefinition))).Replace("-", "").ToLowerInvariant();
                if (actual != schemaDigest) throw new ArgumentException("conversion_schema_digest_mismatch");
            }
            CanonicalDefinition = canonicalDefinition; SchemaVersion = schemaVersion; SchemaDigest = schemaDigest;
        }

        [Serializable]
        private sealed class BundleFields
        {
            public string format = string.Empty;
            public string schema_version = string.Empty;
            public string schema_digest = string.Empty;
            public string canonical_definition = string.Empty;
        }

        public static OpenMasuAppleMeaningConfiguration FromBundle(string json)
        {
            if (string.IsNullOrEmpty(json) || Encoding.UTF8.GetByteCount(json) > 65536)
                throw new ArgumentException("conversion_meaning_bundle_invalid");
            var bundle = JsonUtility.FromJson<BundleFields>(json);
            if (bundle == null || bundle.format != "openmasu.apple-conversion-meaning.v1")
                throw new ArgumentException("conversion_meaning_bundle_invalid");
            return new OpenMasuAppleMeaningConfiguration(bundle.canonical_definition, bundle.schema_version, bundle.schema_digest);
        }
    }

    /// <summary>Local controller result, not verified postback delivery or actual revenue.</summary>
    public sealed class OpenMasuAppleMeaningResult
    {
        public OpenMasuAppleMeaningState State { get; private set; }
        public OpenMasuAppleMeaningError Error { get; private set; }
        public int? FineValue { get; private set; }
        public OpenMasuAppleCoarseValue? CoarseValue { get; private set; }
        public bool? LockPostback { get; private set; }

        internal static OpenMasuAppleMeaningResult Parse(string value)
        {
            var fields = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var pair in (value ?? "").Split('&'))
            {
                var parts = pair.Split(new[] { '=' }, 2);
                if (parts.Length != 2 || fields.ContainsKey(parts[0])) throw Invalid();
                fields.Add(parts[0], parts[1]);
            }
            if (!fields.TryGetValue("state", out var state)) throw Invalid();
            if (state == "ready" && fields.Count == 1) return new OpenMasuAppleMeaningResult { State = OpenMasuAppleMeaningState.Ready };
            if (state == "updated" && fields.Count == 4 && fields.TryGetValue("fine", out var fine) &&
                int.TryParse(fine, NumberStyles.None, CultureInfo.InvariantCulture, out var number) && number >= 0 && number <= 63 &&
                fields.TryGetValue("coarse", out var coarse) && (coarse == "low" || coarse == "medium" || coarse == "high") &&
                fields.TryGetValue("lock", out var locked) && (locked == "true" || locked == "false"))
                return new OpenMasuAppleMeaningResult { State = OpenMasuAppleMeaningState.Updated, FineValue = number,
                    CoarseValue = (OpenMasuAppleCoarseValue)Enum.Parse(typeof(OpenMasuAppleCoarseValue), coarse, true), LockPostback = locked == "true" };
            if (state == "not_applied" && fields.Count == 2 && fields.TryGetValue("error", out var error) &&
                Regex.IsMatch(error, @"\A[a-z_]+\z") && Enum.TryParse(error.Replace("_", ""), true, out OpenMasuAppleMeaningError code) &&
                Enum.IsDefined(typeof(OpenMasuAppleMeaningError), code) && code != OpenMasuAppleMeaningError.None)
                return new OpenMasuAppleMeaningResult { State = OpenMasuAppleMeaningState.NotApplied, Error = code };
            throw Invalid();
        }
        private static FormatException Invalid() => new FormatException("conversion_meaning_response_invalid");
    }

    // Additive interface keeps existing host platform implementations source compatible.
    public interface IOpenMasuAppleMeaningPlatform
    {
        void InitializeAppleMeaning(OpenMasuOptions options, OpenMasuAppleMeaningConfiguration configuration, Action<string> completion);
        void RecordAppleMeaning(string localOperationKey, string eventKey, string revenueUnscaled,
            OpenMasuAppleWindow window, bool consentGranted, Action<string> completion);
    }

    public sealed partial class OpenMasuClient
    {
        /// <summary>Use instead of Initialize for this profile; wait for Ready before recording.</summary>
        public void InitializeAppleMeaning(OpenMasuOptions options, OpenMasuAppleMeaningConfiguration configuration,
            Action<OpenMasuAppleMeaningResult> completion)
        {
            if (options == null || configuration == null || completion == null) throw new ArgumentNullException();
            if (disposed) throw new ObjectDisposedException(nameof(OpenMasuClient));
            var target = AppleMeaningPlatform();
            ResetAdRevenueContext(); ChangeAdRevenueCollection(false);
            target.InitializeAppleMeaning(options, configuration, value => dispatcher.Post(() => { if (!disposed) completion(OpenMasuAppleMeaningResult.Parse(value)); }));
        }

        public void RecordAppleMeaning(string localOperationKey, string eventKey, string revenueUnscaled,
            OpenMasuAppleWindow window, bool consentGranted, Action<OpenMasuAppleMeaningResult> completion)
        {
            if (disposed) throw new ObjectDisposedException(nameof(OpenMasuClient));
            if (completion == null) throw new ArgumentNullException(nameof(completion));
            if (!IsIdentifier(localOperationKey) || !Regex.IsMatch(eventKey ?? "", @"\A[a-z][a-z0-9_]{1,47}\z"))
                throw new ArgumentException("conversion_signal_invalid");
            if (!Enum.IsDefined(typeof(OpenMasuAppleWindow), window)) throw new ArgumentOutOfRangeException(nameof(window), "conversion_window_invalid");
            if (revenueUnscaled != null && !Regex.IsMatch(revenueUnscaled, @"\A(0|[1-9][0-9]{0,14})\z"))
                throw new ArgumentException("conversion_revenue_invalid");
            AppleMeaningPlatform().RecordAppleMeaning(localOperationKey, eventKey, revenueUnscaled, window, consentGranted,
                value => dispatcher.Post(() => { if (!disposed) completion(OpenMasuAppleMeaningResult.Parse(value)); }));
        }

        private IOpenMasuAppleMeaningPlatform AppleMeaningPlatform() => platform as IOpenMasuAppleMeaningPlatform
            ?? throw new NotSupportedException("openmasu_apple_meaning_platform_unavailable");
    }
}
