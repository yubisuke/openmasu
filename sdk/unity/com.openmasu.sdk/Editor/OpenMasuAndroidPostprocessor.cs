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
                .SingleOrDefault(value => (string)value.Attribute(Android + "name") == normalizedActivity)
                ?? throw new InvalidDataException("unity activity missing");

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
            var settingsPath = Path.Combine(
                Directory.GetCurrentDirectory(), "ProjectSettings", "OpenMasuAndroidSettings.json");
            if (!File.Exists(settingsPath)) return;

            var manifestPath = Path.Combine(projectPath, "src", "main", "AndroidManifest.xml");
            if (!File.Exists(manifestPath)) throw new BuildFailedException("generated AndroidManifest.xml is missing");

            try
            {
                var settings = JsonUtility.FromJson<OpenMasuAndroidSettings>(File.ReadAllText(settingsPath));
                if (settings == null) throw new InvalidDataException("settings JSON is empty");
                File.WriteAllText(manifestPath, OpenMasuAndroidManifestSettings.Apply(
                    File.ReadAllText(manifestPath), settings.linkHosts, settings.activityName));
            }
            catch (Exception exception)
            {
                throw new BuildFailedException("OpenMasu Android App Links configuration is invalid: " + exception.Message);
            }
        }
    }
}
#endif
