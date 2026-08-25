using System;
using System.IO;
using System.Linq;
using System.Xml.Linq;

namespace OpenMmp.Unity.Editor
{
    public static class OpenMmpIosPlistSettings
    {
        public static string Apply(
            string xml,
            string skanEndpoint,
            string attributionCopyEndpoint,
            bool collectionEnabledByDefault = false)
        {
            RequireHttps(skanEndpoint, nameof(skanEndpoint));
            RequireHttps(attributionCopyEndpoint, nameof(attributionCopyEndpoint));
            var document = XDocument.Parse(xml, LoadOptions.PreserveWhitespace);
            var dictionary = document.Root?.Element("dict") ?? throw new InvalidDataException("plist dictionary missing");
            SetString(dictionary, "NSAdvertisingAttributionReportEndpoint", skanEndpoint);
            SetString(dictionary, "AttributionCopyEndpoint", attributionCopyEndpoint);
            SetBoolean(dictionary, "OpenMmpCollectionEnabledDefault", collectionEnabledByDefault);
            return document.ToString(SaveOptions.DisableFormatting);
        }

        private static void SetString(XElement dictionary, string key, string value)
        {
            var nodes = dictionary.Elements().ToList();
            for (var index = 0; index + 1 < nodes.Count; index++)
            {
                if (nodes[index].Name == "key" && nodes[index].Value == key)
                {
                    nodes[index + 1].ReplaceWith(new XElement("string", value));
                    return;
                }
            }
            dictionary.Add(new XElement("key", key), new XElement("string", value));
        }

        private static void SetBoolean(XElement dictionary, string key, bool value)
        {
            var nodes = dictionary.Elements().ToList();
            for (var index = 0; index + 1 < nodes.Count; index++)
            {
                if (nodes[index].Name == "key" && nodes[index].Value == key)
                {
                    nodes[index + 1].ReplaceWith(new XElement(value ? "true" : "false"));
                    return;
                }
            }
            dictionary.Add(new XElement("key", key), new XElement(value ? "true" : "false"));
        }

        private static void RequireHttps(string value, string name)
        {
            if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps)
                throw new ArgumentException("endpoint_must_be_https", name);
        }
    }
}

#if UNITY_EDITOR && UNITY_IOS
namespace OpenMmp.Unity.Editor
{
    using UnityEditor;
    using UnityEditor.Callbacks;
    using UnityEditor.iOS.Xcode;
    using UnityEngine;

    internal sealed class OpenMmpIosSettings
    {
        public string skanEndpoint = string.Empty;
        public string attributionCopyEndpoint = string.Empty;
        public bool collectionEnabledByDefault = false;
    }

    public static class OpenMmpIOSPostprocessor
    {
        [PostProcessBuild(500)]
        public static void OnPostProcessBuild(BuildTarget target, string projectPath)
        {
            if (target != BuildTarget.iOS) return;
            var settingsPath = Path.Combine(Directory.GetCurrentDirectory(), "ProjectSettings", "OpenMmpIOSSettings.json");
            if (!File.Exists(settingsPath)) throw new UnityEditor.Build.BuildFailedException("ProjectSettings/OpenMmpIOSSettings.json is required");
            var settings = JsonUtility.FromJson<OpenMmpIosSettings>(File.ReadAllText(settingsPath));
            var plistPath = Path.Combine(projectPath, "Info.plist");
            File.WriteAllText(plistPath, OpenMmpIosPlistSettings.Apply(
                File.ReadAllText(plistPath), settings.skanEndpoint, settings.attributionCopyEndpoint,
                settings.collectionEnabledByDefault));

            var pbxPath = PBXProject.GetPBXProjectPath(projectPath);
            var project = new PBXProject();
            project.ReadFromFile(pbxPath);
            var targetGuid = project.GetUnityMainTargetGuid();
            project.SetBuildProperty(targetGuid, "SWIFT_VERSION", "5.0");
            project.SetBuildProperty(targetGuid, "CLANG_ENABLE_MODULES", "YES");
            project.AddBuildProperty(targetGuid, "OTHER_LDFLAGS", "-lsqlite3");

            var packageRoot = Path.Combine(
                Directory.GetCurrentDirectory(), "Packages", "com.openmmp.sdk", "Runtime", "Plugins", "iOS");
            var swiftRoot = Path.Combine(packageRoot, "Sources");
            foreach (var source in Directory.GetFiles(swiftRoot, "*.swift", SearchOption.AllDirectories))
            {
                var relative = Path.GetRelativePath(swiftRoot, source).Replace('\\', '/');
                var projectRelative = "OpenMmp/Sources/" + relative;
                var destination = Path.Combine(projectPath, projectRelative.Replace('/', Path.DirectorySeparatorChar));
                Directory.CreateDirectory(Path.GetDirectoryName(destination));
                File.Copy(source, destination, true);
                var guid = project.AddFile(projectRelative, projectRelative);
                project.AddFileToBuild(targetGuid, guid);
            }

            var manifestSource = Path.Combine(packageRoot, "PrivacyInfo.xcprivacy");
            var manifestDestination = Path.Combine(projectPath, "PrivacyInfo.xcprivacy");
            File.Copy(manifestSource, manifestDestination, true);
            var manifestGuid = project.AddFile("PrivacyInfo.xcprivacy", "PrivacyInfo.xcprivacy");
            project.AddFileToBuild(targetGuid, manifestGuid);

            var schemaSource = Path.Combine(
                swiftRoot, "OpenMmpApplePostback", "Resources", "conversion-schema-v1.json");
            var schemaRelative = "OpenMmp/conversion-schema-v1.json";
            var schemaDestination = Path.Combine(projectPath, schemaRelative.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(schemaDestination));
            File.Copy(schemaSource, schemaDestination, true);
            var schemaGuid = project.AddFile(schemaRelative, schemaRelative);
            project.AddFileToBuild(targetGuid, schemaGuid);
            project.WriteToFile(pbxPath);
        }
    }
}
#endif
