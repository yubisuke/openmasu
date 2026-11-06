using System;
using System.Text;
using UnityEngine;

namespace OpenMasu.Unity
{
    public enum OpenMasuPrivacyRequestType { Access, Portability }
    public enum OpenMasuPrivacyStatus { PageReady, Complete, ResetPending, ContextChanged, NotEnrolled, Unsupported, InvalidRequest, RequestFailed }
    public interface IOpenMasuPrivacyPlatform
    {
        void RequestPrivacyPage(string requestType, string cursor, int pageSize, Action<string> completion);
    }

    public sealed class OpenMasuPrivacyResult
    {
        public OpenMasuPrivacyStatus Status { get; private set; }
        public OpenMasuPrivacyPage Page { get; private set; }
        internal OpenMasuPrivacyResult(OpenMasuPrivacyStatus status, OpenMasuPrivacyPage page = null) { Status = status; Page = page; }
        public override string ToString() => "OpenMasuPrivacyResult(" + Status + ")";
        internal static OpenMasuPrivacyResult Parse(string value, string requestType, int pageSize)
        {
            if (value == null || value.Length > 262200) throw new FormatException();
            var separator = value.IndexOf('\n');
            if (separator < 0) throw new FormatException();
            var statusText = value.Substring(0, separator);
            if (!Enum.TryParse(statusText.Replace("_", ""), true, out OpenMasuPrivacyStatus status) ||
                !Enum.IsDefined(typeof(OpenMasuPrivacyStatus), status) || statusText.Length == 0 || char.IsDigit(statusText[0])) throw new FormatException();
            var json = value.Substring(separator + 1);
            if (status != OpenMasuPrivacyStatus.PageReady && status != OpenMasuPrivacyStatus.Complete)
            {
                if (json.Length != 0) throw new FormatException();
                return new OpenMasuPrivacyResult(status);
            }
            if (Encoding.UTF8.GetByteCount(json) > 262144) throw new FormatException();
            var fields = JsonUtility.FromJson<OpenMasuPrivacyFields>(json);
            if (fields == null || fields.dsar_response_version != "internal-v2" || fields.request_type != requestType ||
                string.IsNullOrEmpty(fields.request_id) || fields.request_id.Length > 128 ||
                fields.cutoff_at == null || fields.cutoff_at.Length < 20 || fields.cutoff_at.Length > 40 ||
                fields.page_size != pageSize || fields.returned_count < 0 || fields.returned_count > pageSize ||
                fields.complete != (status == OpenMasuPrivacyStatus.Complete) ||
                fields.complete != (fields.next_cursor == null) || !OpenMasuClient.ValidPrivacyRequest(fields.next_cursor, pageSize)) throw new FormatException();
            return new OpenMasuPrivacyResult(status, new OpenMasuPrivacyPage(json, fields));
        }
    }

    [Serializable]
    internal sealed class OpenMasuPrivacyFields
    {
        public string dsar_response_version, request_type, request_id, cutoff_at, next_cursor;
        public bool complete;
        public int page_size, returned_count;
    }

    public sealed class OpenMasuPrivacyPage
    {
        public string PayloadJson { get; }
        public string RequestId { get; }
        public string CutoffAt { get; }
        public string NextCursor { get; }
        public bool Complete { get; }
        public int ReturnedCount { get; }
        internal OpenMasuPrivacyPage(string json, OpenMasuPrivacyFields fields)
        {
            PayloadJson = json; RequestId = fields.request_id; CutoffAt = fields.cutoff_at;
            NextCursor = fields.next_cursor; Complete = fields.complete; ReturnedCount = fields.returned_count;
        }
        public override string ToString() => "OpenMasuPrivacyPage(redacted)";
    }

    public sealed partial class OpenMasuClient
    {
        private long privacyRevision;
        private bool privacyResetPending;
        internal static bool ValidPrivacyRequest(string cursor, int pageSize)
        {
            if (pageSize < 1 || pageSize > 500) return false;
            if (cursor == null) return true;
            if (cursor.Length < 1 || cursor.Length > 16384) return false;
            foreach (var c in cursor) if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-')) return false;
            return true;
        }
        /// <summary>Fetch one page. No disk save, sharing, event queue or automatic all-history loop.</summary>
        public void RequestPrivacyPage(OpenMasuPrivacyRequestType requestType, Action<OpenMasuPrivacyResult> completion,
            string cursor = null, int pageSize = 200)
        {
            if (completion == null) throw new ArgumentNullException(nameof(completion));
            var revision = privacyRevision;
            if (!Enum.IsDefined(typeof(OpenMasuPrivacyRequestType), requestType) || !ValidPrivacyRequest(cursor, pageSize))
            { dispatcher.Post(() => completion(new OpenMasuPrivacyResult(OpenMasuPrivacyStatus.InvalidRequest))); return; }
            if (privacyResetPending || disposed)
            { dispatcher.Post(() => completion(new OpenMasuPrivacyResult(OpenMasuPrivacyStatus.ResetPending))); return; }
            var capable = platform as IOpenMasuPrivacyPlatform;
            if (capable == null)
            { dispatcher.Post(() => completion(new OpenMasuPrivacyResult(OpenMasuPrivacyStatus.Unsupported))); return; }
            var wire = requestType == OpenMasuPrivacyRequestType.Access ? "access" : "portability";
            capable.RequestPrivacyPage(wire, cursor, pageSize, value => dispatcher.Post(() => {
                if (revision != privacyRevision || privacyResetPending || disposed)
                { completion(new OpenMasuPrivacyResult(OpenMasuPrivacyStatus.ContextChanged)); return; }
                OpenMasuPrivacyResult result;
                try { result = OpenMasuPrivacyResult.Parse(value, wire, pageSize); }
                catch { result = new OpenMasuPrivacyResult(OpenMasuPrivacyStatus.RequestFailed); }
                completion(result);
            }));
        }
    }
}
