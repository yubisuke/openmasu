using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace OpenMasu.Unity.Editor
{
    public static class OpenMasuAndroidManifestSettings
    {
        public const string DefaultActivityName = "com.unity3d.player.UnityPlayerActivity";
        public const string UnityGameActivityName = "com.unity3d.player.UnityPlayerGameActivity";
        public const string LinkHostsMetadataName = "dev.openmasu.sdk.LINK_HOSTS";
        public const string LinkFilterLabel = "OpenMasu measurement links";
        private static readonly XNamespace Android = "http://schemas.android.com/apk/res/android";

        public static string Apply(
            string xml,
            IReadOnlyList<string> linkHosts,
            string activityName = DefaultActivityName)
        {
            var hosts = OpenMasuIosPlistSettings.ValidateLinkHosts(linkHosts);
            if (hosts.Length == 0) throw new ArgumentException("link_hosts_required", nameof(linkHosts));
            if (hosts.Contains("links.synthetic.invalid", StringComparer.Ordinal))
                throw new ArgumentException("synthetic_link_host_forbidden", nameof(linkHosts));

            var normalizedActivity = (activityName ?? string.Empty).Trim();
            if (!Regex.IsMatch(normalizedActivity, "^([A-Za-z_][A-Za-z0-9_]*\\.)+[A-Za-z_][A-Za-z0-9_]*$"))
                throw new ArgumentException("activity_name_invalid", nameof(activityName));

            var document = XDocument.Parse(xml, LoadOptions.PreserveWhitespace);
            var application = document.Root?.Element("application")
                ?? throw new InvalidDataException("android application missing");
            var activity = application.Elements("activity")
                .SingleOrDefault(value => (string)value.Attribute(Android + "name") == normalizedActivity);
            if (activity == null && normalizedActivity == DefaultActivityName)
            {
                activity = application.Elements("activity")
                    .SingleOrDefault(value =>
                        (string)value.Attribute(Android + "name") == UnityGameActivityName);
            }
            if (activity == null) throw new InvalidDataException("unity activity missing");

            activity.Elements("intent-filter")
                .Where(value => (string)value.Attribute(Android + "label") == LinkFilterLabel)
                .Remove();
            application.Elements("meta-data")
                .Where(value => (string)value.Attribute(Android + "name") == LinkHostsMetadataName)
                .Remove();

            application.Add(new XElement("meta-data",
                new XAttribute(Android + "name", LinkHostsMetadataName),
                new XAttribute(Android + "value", string.Join(",", hosts))));

            foreach (var host in hosts)
            {
                activity.Add(new XElement("intent-filter",
                    new XAttribute(Android + "autoVerify", "true"),
                    new XAttribute(Android + "label", LinkFilterLabel),
                    new XElement("action", new XAttribute(Android + "name", "android.intent.action.VIEW")),
                    new XElement("category", new XAttribute(Android + "name", "android.intent.category.DEFAULT")),
                    new XElement("category", new XAttribute(Android + "name", "android.intent.category.BROWSABLE")),
                    new XElement("data", new XAttribute(Android + "scheme", "http")),
                    new XElement("data", new XAttribute(Android + "scheme", "https")),
                    new XElement("data",
                        new XAttribute(Android + "host", host),
                        new XAttribute(Android + "pathPrefix", "/r/"))));
            }

            return document.ToString(SaveOptions.DisableFormatting);
        }
    }

    public static class OpenMasuAndroidGradleSettings
    {
        public const string BeginMarker = "// OPENMASU_PACKAGED_MAVEN_BEGIN";
        public const string EndMarker = "// OPENMASU_PACKAGED_MAVEN_END";

        public static string Apply(string source)
        {
            if (source == null) throw new ArgumentNullException(nameof(source));
            var hasBegin = source.Contains(BeginMarker, StringComparison.Ordinal);
            var hasEnd = source.Contains(EndMarker, StringComparison.Ordinal);
            if (hasBegin != hasEnd) throw new InvalidDataException("OpenMasu Gradle marker mismatch");
            if (hasBegin) return source;

            var dependencyBlock = FindBlock(source, "dependencyResolutionManagement", 0);
            var repositoriesBlock = FindBlock(source, "repositories", dependencyBlock.openBrace + 1);
            if (repositoriesBlock.openBrace > dependencyBlock.closeBrace)
                throw new InvalidDataException("Gradle dependency repositories block is missing");

            var lineEnding = source.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";
            var lineStart = source.LastIndexOf('\n', repositoriesBlock.closeBrace);
            lineStart = lineStart < 0 ? 0 : lineStart + 1;
            var closeIndent = source.Substring(lineStart, repositoriesBlock.closeBrace - lineStart);
            if (closeIndent.Any(character => character != ' ' && character != '\t')) closeIndent = string.Empty;
            var indent = closeIndent + "    ";
            var nested = indent + "    ";
            var deeper = nested + "    ";
            var insertion =
                indent + BeginMarker + lineEnding +
                indent + "exclusiveContent {" + lineEnding +
                nested + "forRepository {" + lineEnding +
                deeper + "maven {" + lineEnding +
                deeper + "    name = 'openMasuPackaged'" + lineEnding +
                deeper + "    url = uri(new File(settingsDir, 'unityLibrary/OpenMasu.androidlib/maven'))" + lineEnding +
                deeper + "}" + lineEnding +
                nested + "}" + lineEnding +
                nested + "filter { includeGroup 'dev.openmasu' }" + lineEnding +
                indent + "}" + lineEnding +
                indent + EndMarker + lineEnding;
            return source.Insert(lineStart, insertion);
        }

        private static (int openBrace, int closeBrace) FindBlock(
            string source,
            string name,
            int startIndex)
        {
            var match = Regex.Match(source.Substring(startIndex), @"\b" + Regex.Escape(name) + @"\s*\{");
            if (!match.Success) throw new InvalidDataException("Gradle " + name + " block is missing");
            var openBrace = source.IndexOf('{', startIndex + match.Index);
            var depth = 0;
            for (var index = openBrace; index < source.Length; index++)
            {
                if (source[index] == '{') depth++;
                if (source[index] != '}') continue;
                depth--;
                if (depth == 0) return (openBrace, index);
            }
            throw new InvalidDataException("Gradle " + name + " block is unterminated");
        }
    }
}

#if UNITY_EDITOR && UNITY_ANDROID
namespace OpenMasu.Unity.Editor
{
    using UnityEditor.Android;
    using UnityEditor.Build;
    using UnityEngine;

    internal sealed class OpenMasuAndroidSettings
    {
        public string[] linkHosts = Array.Empty<string>();
        public string activityName = OpenMasuAndroidManifestSettings.DefaultActivityName;
    }

    public sealed class OpenMasuAndroidPostprocessor : IPostGenerateGradleAndroidProject
    {
        public int callbackOrder => 500;

        public void OnPostGenerateGradleAndroidProject(string projectPath)
        {
            try
            {
                var packagedMaven = Path.Combine(projectPath, "OpenMasu.androidlib", "maven");
                if (Directory.Exists(packagedMaven))
                {
                    var parent = Directory.GetParent(projectPath)?.FullName;
                    var gradleSettingsPath = parent == null
                        ? string.Empty
                        : Path.Combine(parent, "settings.gradle");
                    if (!File.Exists(gradleSettingsPath))
                        throw new FileNotFoundException("generated Gradle settings.gradle is missing");
                    File.WriteAllText(
                        gradleSettingsPath,
                        OpenMasuAndroidGradleSettings.Apply(File.ReadAllText(gradleSettingsPath)));
                }

                var settingsPath = Path.Combine(
                    Directory.GetCurrentDirectory(), "ProjectSettings", "OpenMasuAndroidSettings.json");
                if (!File.Exists(settingsPath)) return;
                var manifestPath = Path.Combine(projectPath, "src", "main", "AndroidManifest.xml");
                if (!File.Exists(manifestPath))
                    throw new FileNotFoundException("generated AndroidManifest.xml is missing");
                var settings = JsonUtility.FromJson<OpenMasuAndroidSettings>(File.ReadAllText(settingsPath));
                if (settings == null) throw new InvalidDataException("settings JSON is empty");
                File.WriteAllText(manifestPath, OpenMasuAndroidManifestSettings.Apply(
                    File.ReadAllText(manifestPath), settings.linkHosts, settings.activityName));
            }
            catch (Exception exception)
            {
                throw new BuildFailedException("OpenMasu Android generated project configuration is invalid: " + exception.Message);
            }
        }
    }
}
#endif
