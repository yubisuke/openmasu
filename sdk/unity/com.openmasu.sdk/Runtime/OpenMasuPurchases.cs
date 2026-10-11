using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;

namespace OpenMasu.Unity
{
    // Additive interfaces: existing platform implementations keep working.
    public interface IOpenMasuGooglePlayPurchasePlatform
    {
        void TrackGooglePlayProductPurchase(string purchaseToken, string productId, string transactionId,
            string amountUnscaled, int amountScale, string currency, Action<string> completion);
        void TrackGooglePlaySubscriptionPurchase(string purchaseToken, string productId, string transactionId,
            string amountUnscaled, int amountScale, string currency, Action<string> completion);
    }

    public interface IOpenMasuAppStorePurchasePlatform
    {
        void PrepareAppStorePurchase(string productId, string requestId, bool revenueMeasurementConsent,
            Action<string> completion);
        void SubmitAppStorePurchase(string prepared, string signedTransaction, bool revenueMeasurementConsent,
            Action<string> completion);
    }

    public interface IOpenMasuConsentPlatform
    {
        void UpdateConsent(string state, string policyVersion, Action<string> completion);
    }

    public enum OpenMasuConsentState { Granted, Denied, Withdrawn, NotRequired, Unknown }
    // None of these states is proof of store verification or entitlement.
    public enum OpenMasuPurchaseState { NotSubmitted, Prepared, Queued, Pending }

    public sealed class OpenMasuPreparedAppStorePurchase
    {
        public Guid AppAccountToken { get; }
        internal string Payload { get; }
        internal OpenMasuPreparedAppStorePurchase(string payload, Guid appAccountToken)
        {
            Payload = payload;
            AppAccountToken = appAccountToken;
        }
        public override string ToString() => "OpenMasuPreparedAppStorePurchase (protected)";
    }

    public sealed class OpenMasuPurchaseResult
    {
        public OpenMasuPurchaseState State { get; private set; }
        public string ErrorCode { get; private set; }
        public OpenMasuPreparedAppStorePurchase PreparedPurchase { get; private set; }

        internal static Dictionary<string, string> Fields(string value)
        {
            var result = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var pair in (value ?? string.Empty).Split('&'))
            {
                var parts = pair.Split(new[] { '=' }, 2);
                if (parts.Length == 2) result[parts[0]] = Uri.UnescapeDataString(parts[1]);
            }
            return result;
        }

        internal static OpenMasuPurchaseResult Parse(string value, OpenMasuPurchaseState successState)
        {
            var fields = Fields(value);
            fields.TryGetValue("state", out var state);
            if (state != successState.ToString().ToLowerInvariant())
                return new OpenMasuPurchaseResult {
                    State = OpenMasuPurchaseState.NotSubmitted,
                    // Native errors are closed codes. Never surface arbitrary native text.
                    ErrorCode = "purchase_not_submitted",
                };
            var result = new OpenMasuPurchaseResult { State = successState };
            if (successState == OpenMasuPurchaseState.Prepared)
            {
                if (!fields.TryGetValue("prepared", out var payload) || string.IsNullOrEmpty(payload) ||
                    payload.Length > 8192 || !fields.TryGetValue("app_account_token", out var token) ||
                    !Guid.TryParse(token, out var appAccountToken))
                    return new OpenMasuPurchaseResult {
                        State = OpenMasuPurchaseState.NotSubmitted, ErrorCode = "purchase_response_invalid",
                    };
                result.PreparedPurchase = new OpenMasuPreparedAppStorePurchase(payload, appAccountToken);
            }
            return result;
        }
    }

    public sealed partial class OpenMasuClient
    {
        public void TrackGooglePlayProductPurchase(string purchaseToken, string productId, string transactionId,
            string amountUnscaled, int amountScale, string currency, Action<OpenMasuPurchaseResult> completion)
        {
            ValidateProtectedPurchase(purchaseToken, productId, transactionId, amountUnscaled, amountScale, currency);
            PurchasePlatform<IOpenMasuGooglePlayPurchasePlatform>().TrackGooglePlayProductPurchase(
                purchaseToken, productId, transactionId, amountUnscaled, amountScale, currency,
                PurchaseCompletion(completion, OpenMasuPurchaseState.Queued));
        }

        public void TrackGooglePlaySubscriptionPurchase(string purchaseToken, string productId, string transactionId,
            string amountUnscaled, int amountScale, string currency, Action<OpenMasuPurchaseResult> completion)
        {
            ValidateProtectedPurchase(purchaseToken, productId, transactionId, amountUnscaled, amountScale, currency);
            PurchasePlatform<IOpenMasuGooglePlayPurchasePlatform>().TrackGooglePlaySubscriptionPurchase(
                purchaseToken, productId, transactionId, amountUnscaled, amountScale, currency,
                PurchaseCompletion(completion, OpenMasuPurchaseState.Queued));
        }

        public void PrepareAppStorePurchase(string productId, Guid requestId, bool revenueMeasurementConsent,
            Action<OpenMasuPurchaseResult> completion)
        {
            ValidateProductId(productId);
            if (requestId == Guid.Empty) throw new ArgumentException("purchase_request_id_invalid", nameof(requestId));
            PurchasePlatform<IOpenMasuAppStorePurchasePlatform>().PrepareAppStorePurchase(
                productId, requestId.ToString("D"), revenueMeasurementConsent,
                PurchaseCompletion(completion, OpenMasuPurchaseState.Prepared));
        }

        public void SubmitAppStorePurchase(OpenMasuPreparedAppStorePurchase prepared, string signedTransaction,
            bool revenueMeasurementConsent, Action<OpenMasuPurchaseResult> completion)
        {
            if (prepared == null) throw new ArgumentNullException(nameof(prepared));
            if (string.IsNullOrEmpty(signedTransaction) || signedTransaction.Length > 256 * 1024)
                throw new ArgumentException("signed_transaction_invalid", nameof(signedTransaction));
            PurchasePlatform<IOpenMasuAppStorePurchasePlatform>().SubmitAppStorePurchase(
                prepared.Payload, signedTransaction, revenueMeasurementConsent,
                PurchaseCompletion(completion, OpenMasuPurchaseState.Pending));
        }

        public void UpdateConsent(OpenMasuConsentState state, string policyVersion, Action<bool> completion)
        {
            if (!Enum.IsDefined(typeof(OpenMasuConsentState), state)) throw new ArgumentOutOfRangeException(nameof(state));
            if (!IsIdentifier(policyVersion)) throw new ArgumentException("consent_policy_version_invalid", nameof(policyVersion));
            if (completion == null) throw new ArgumentNullException(nameof(completion));
            var nativeState = state == OpenMasuConsentState.NotRequired ? "not_required" : state.ToString().ToLowerInvariant();
            PurchasePlatform<IOpenMasuConsentPlatform>().UpdateConsent(nativeState, policyVersion,
                OnceOnMainThread(value => completion(OpenMasuPurchaseResult.Fields(value)
                    .TryGetValue("state", out var result) && result == "updated")));
        }

        private T PurchasePlatform<T>() where T : class
        {
            if (disposed) throw new ObjectDisposedException(nameof(OpenMasuClient));
            return platform as T ?? throw new NotSupportedException("openmasu_purchase_platform_unavailable");
        }

        private Action<string> PurchaseCompletion(Action<OpenMasuPurchaseResult> completion, OpenMasuPurchaseState success)
        {
            if (completion == null) throw new ArgumentNullException(nameof(completion));
            return OnceOnMainThread(value => completion(OpenMasuPurchaseResult.Parse(value, success)));
        }

        private Action<string> OnceOnMainThread(Action<string> completion)
        {
            var completed = 0;
            return value => {
                if (Interlocked.Exchange(ref completed, 1) != 0) return;
                dispatcher.Post(() => { if (!disposed) completion(value); });
            };
        }

        private static void ValidateProtectedPurchase(string token, string productId, string transactionId,
            string amountUnscaled, int amountScale, string currency)
        {
            if (string.IsNullOrEmpty(token) || Encoding.UTF8.GetByteCount(token) > 64 * 1024)
                throw new ArgumentException("purchase_token_invalid", nameof(token));
            ValidateProductId(productId, allowColon: true);
            ValidateCommerceEvent(transactionId, amountUnscaled, amountScale, currency);
        }

        private static void ValidateProductId(string productId, bool allowColon = false)
        {
            if (string.IsNullOrEmpty(productId) || productId.Length > 255)
                throw new ArgumentException("product_id_invalid", nameof(productId));
            foreach (var c in productId)
                if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
                    c == '.' || c == '_' || c == '-' || (allowColon && c == ':')))
                    throw new ArgumentException("product_id_invalid", nameof(productId));
        }
    }
}
