using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;

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
        public static T FromJson<T>(string json) => JsonSerializer.Deserialize<T>(json, new JsonSerializerOptions
        {
            IncludeFields = true,
        });
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

namespace UnityEditor
{
    public enum BuildTarget
    {
        Android,
        iOS,
    }
}

namespace UnityEditor.Callbacks
{
    [AttributeUsage(AttributeTargets.Method)]
    public sealed class PostProcessBuildAttribute : Attribute
    {
        public PostProcessBuildAttribute(int callbackOrder) { }
    }
}

namespace UnityEditor.iOS.Xcode
{
    public sealed class PBXProject
    {
        public const string MainTargetGuid = "synthetic-main-target";
        public const string FrameworkTargetGuid = "synthetic-framework-target";
        public static PBXProject LastWrittenProject { get; private set; }

        private readonly Dictionary<string, string> fileGuids = new Dictionary<string, string>(StringComparer.Ordinal);
        private readonly Dictionary<string, HashSet<string>> buildFiles = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        private readonly Dictionary<string, Dictionary<string, List<string>>> buildProperties =
            new Dictionary<string, Dictionary<string, List<string>>>(StringComparer.Ordinal);

        public static string GetPBXProjectPath(string projectPath) =>
            Path.Combine(projectPath, "Unity-iPhone.xcodeproj", "project.pbxproj");

        public void ReadFromFile(string path)
        {
            if (!File.Exists(path)) throw new FileNotFoundException("synthetic PBX project is missing", path);
        }

        public string GetUnityMainTargetGuid() => MainTargetGuid;
        public string GetUnityFrameworkTargetGuid() => FrameworkTargetGuid;

        public void SetBuildProperty(string targetGuid, string name, string value)
        {
            Properties(targetGuid)[name] = new List<string> { value };
        }

        public void AddBuildProperty(string targetGuid, string name, string value)
        {
            if (!Properties(targetGuid).TryGetValue(name, out var values))
            {
                values = new List<string>();
                Properties(targetGuid)[name] = values;
            }
            values.Add(value);
        }

        public string AddFile(string projectPath, string realPath)
        {
            if (!fileGuids.TryGetValue(projectPath, out var guid))
            {
                guid = "synthetic-file-" + fileGuids.Count;
                fileGuids[projectPath] = guid;
            }
            return guid;
        }

        public void AddFileToBuild(string targetGuid, string fileGuid)
        {
            if (!buildFiles.TryGetValue(targetGuid, out var files))
            {
                files = new HashSet<string>(StringComparer.Ordinal);
                buildFiles[targetGuid] = files;
            }
            files.Add(fileGuid);
        }

        public void WriteToFile(string path)
        {
            LastWrittenProject = this;
            File.WriteAllText(path, "// synthetic PBX project written by the OpenMasu compile probe\n");
        }

        public bool HasBuildFile(string targetGuid, string projectPath) =>
            fileGuids.TryGetValue(projectPath, out var guid)
            && buildFiles.TryGetValue(targetGuid, out var files)
            && files.Contains(guid);

        public bool HasBuildProperty(string targetGuid, string name, string value) =>
            buildProperties.TryGetValue(targetGuid, out var properties)
            && properties.TryGetValue(name, out var values)
            && values.Contains(value, StringComparer.Ordinal);

        public bool HasAnyBuildProperty(string targetGuid, string name) =>
            buildProperties.TryGetValue(targetGuid, out var properties) && properties.ContainsKey(name);

        private Dictionary<string, List<string>> Properties(string targetGuid)
        {
            if (!buildProperties.TryGetValue(targetGuid, out var properties))
            {
                properties = new Dictionary<string, List<string>>(StringComparer.Ordinal);
                buildProperties[targetGuid] = properties;
            }
            return properties;
        }
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
