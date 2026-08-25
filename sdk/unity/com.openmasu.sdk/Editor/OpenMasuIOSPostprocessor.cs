using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Xml.Linq;

namespace OpenMasu.Unity.Editor
{
    public static class OpenMasuIosPlistSettings
    {
        public static string Apply(
            string xml,
            string skanEndpoint,
            string attributionCopyEndpoint,
            bool collectionEnabledByDefault = false,
            IReadOnlyList<string> linkHosts = null,
            IReadOnlyList<string> linkSchemes = null)
        {
            RequireHttps(skanEndpoint, nameof(skanEndpoint));
            RequireHttps(attributionCopyEndpoint, nameof(attributionCopyEndpoint));
            var document = XDocument.Parse(xml, LoadOptions.PreserveWhitespace);
            var dictionary = document.Root?.Element("dict") ?? throw new InvalidDataException("plist dictionary missing");
            SetString(dictionary, "NSAdvertisingAttributionReportEndpoint", skanEndpoint);
            SetString(dictionary, "AttributionCopyEndpoint", attributionCopyEndpoint);
            SetBoolean(dictionary, "OpenMasuCollectionEnabledDefault", collectionEnabledByDefault);
            SetStringArray(dictionary, "OpenMasuLinkHosts", ValidateLinkHosts(linkHosts));
            SetStringArray(dictionary, "OpenMasuLinkSchemes", ValidateLinkSchemes(linkSchemes));
            return document.ToString(SaveOptions.DisableFormatting);
        }

        internal static string[] ValidateLinkHosts(IReadOnlyList<string> hosts) => (hosts ?? Array.Empty<string>())
            .Select(value => (value ?? string.Empty).Trim().TrimEnd('.').ToLowerInvariant())
            .Where(value => value.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(value => value, StringComparer.Ordinal)
            .Select(value => value.Contains("?mode=") || !Uri.CheckHostName(value).Equals(UriHostNameType.Dns)
                ? throw new ArgumentException("link_host_invalid") : value)
            .ToArray();

        internal static string[] ValidateLinkSchemes(IReadOnlyList<string> schemes) => (schemes ?? Array.Empty<string>())
            .Select(value => (value ?? string.Empty).Trim().ToLowerInvariant())
            .Where(value => value.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(value => value, StringComparer.Ordinal)
            .Select(value => System.Text.RegularExpressions.Regex.IsMatch(value, "^[a-z][a-z0-9+.-]{1,63}$")
                ? value : throw new ArgumentException("link_scheme_invalid"))
            .ToArray();

        private static void SetStringArray(XElement dictionary, string key, IReadOnlyList<string> values)
        {
            var array = new XElement("array", values.Select(value => new XElement("string", value)));
            var nodes = dictionary.Elements().ToList();
            for (var index = 0; index + 1 < nodes.Count; index++)
            {
                if (nodes[index].Name == "key" && nodes[index].Value == key) { nodes[index + 1].ReplaceWith(array); return; }
            }
            dictionary.Add(new XElement("key", key), array);
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

    public static class OpenMasuAssociatedDomains
    {
        public static string Apply(string xml, IReadOnlyList<string> linkHosts)
        {
            var document = XDocument.Parse(xml, LoadOptions.PreserveWhitespace);
            var dictionary = document.Root?.Element("dict") ?? throw new InvalidDataException("entitlements dictionary missing");
            var values = OpenMasuIosPlistSettings.ValidateLinkHosts(linkHosts).Select(host => "applinks:" + host).ToArray();
            var array = new XElement("array", values.Select(value => new XElement("string", value)));
            var nodes = dictionary.Elements().ToList();
            for (var index = 0; index + 1 < nodes.Count; index++)
            {
                if (nodes[index].Name == "key" && nodes[index].Value == "com.apple.developer.associated-domains") {
                    nodes[index + 1].ReplaceWith(array);
                    return document.ToString(SaveOptions.DisableFormatting);
                }
            }
            dictionary.Add(new XElement("key", "com.apple.developer.associated-domains"), array);
            return document.ToString(SaveOptions.DisableFormatting);
        }
    }
}

#if UNITY_EDITOR && UNITY_IOS
namespace OpenMasu.Unity.Editor
{
    using UnityEditor;
    using UnityEditor.Callbacks;
    using UnityEditor.iOS.Xcode;
    using UnityEngine;

    internal sealed class OpenMasuIosSettings
    {
        public string skanEndpoint = string.Empty;
        public string attributionCopyEndpoint = string.Empty;
        public bool collectionEnabledByDefault = false;
        public string[] linkHosts = Array.Empty<string>();
        public string[] linkSchemes = Array.Empty<string>();
    }

    public static class OpenMasuIOSPostprocessor
    {
        [PostProcessBuild(500)]
        public static void OnPostProcessBuild(BuildTarget target, string projectPath)
        {
            if (target != BuildTarget.iOS) return;
            var settingsPath = Path.Combine(Directory.GetCurrentDirectory(), "ProjectSettings", "OpenMasuIOSSettings.json");
            if (!File.Exists(settingsPath)) throw new UnityEditor.Build.BuildFailedException("ProjectSettings/OpenMasuIOSSettings.json is required");
            var settings = JsonUtility.FromJson<OpenMasuIosSettings>(File.ReadAllText(settingsPath));
            var plistPath = Path.Combine(projectPath, "Info.plist");
            File.WriteAllText(plistPath, OpenMasuIosPlistSettings.Apply(
                File.ReadAllText(plistPath), settings.skanEndpoint, settings.attributionCopyEndpoint,
                settings.collectionEnabledByDefault, settings.linkHosts, settings.linkSchemes));

            var pbxPath = PBXProject.GetPBXProjectPath(projectPath);
            var project = new PBXProject();
            project.ReadFromFile(pbxPath);
            var targetGuid = project.GetUnityMainTargetGuid();
            project.SetBuildProperty(targetGuid, "SWIFT_VERSION", "5.0");
            project.SetBuildProperty(targetGuid, "CLANG_ENABLE_MODULES", "YES");
            project.AddBuildProperty(targetGuid, "OTHER_LDFLAGS", "-lsqlite3");
            var entitlementsRelative = "OpenMasu/OpenMasu.entitlements";
            var entitlementsPath = Path.Combine(projectPath, entitlementsRelative.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(entitlementsPath));
            var emptyEntitlements = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict/></plist>";
            File.WriteAllText(entitlementsPath, OpenMasuAssociatedDomains.Apply(emptyEntitlements, settings.linkHosts));
            project.SetBuildProperty(targetGuid, "CODE_SIGN_ENTITLEMENTS", entitlementsRelative);

            var packageRoot = Path.Combine(
                Directory.GetCurrentDirectory(), "Packages", "com.openmasu.sdk", "Runtime", "Plugins", "iOS");
            var swiftRoot = Path.Combine(packageRoot, "Sources");
            foreach (var source in Directory.GetFiles(swiftRoot, "*.swift", SearchOption.AllDirectories))
            {
                var relative = Path.GetRelativePath(swiftRoot, source).Replace('\\', '/');
                var projectRelative = "OpenMasu/Sources/" + relative;
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
                swiftRoot, "OpenMasuApplePostback", "Resources", "conversion-schema-v1.json");
            var schemaRelative = "OpenMasu/conversion-schema-v1.json";
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
