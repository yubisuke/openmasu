from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ANDROID_NAMESPACE = "{http://schemas.android.com/apk/res/android}"
LINK_LABEL = "OpenMasu measurement links"
LINK_METADATA = "dev.openmasu.sdk.LINK_HOSTS"
SYNTHETIC_HOSTS = ("links-a.synthetic.example", "links-b.synthetic.example")

EDITOR_SCRIPT = r'''using System;
using System.IO;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;

public static class OpenMasuAndroidExportProbe
{
    public static void Build()
    {
        var output = Argument("-openmasuProbeOut");
        if (string.IsNullOrWhiteSpace(output)) throw new ArgumentException("-openmasuProbeOut is required");
        if (string.IsNullOrWhiteSpace(new OpenMasu.Unity.OpenMasuOptions().WrapperVersion))
            throw new BuildFailedException("OpenMasu runtime package is unavailable");
        Directory.CreateDirectory(output);
        var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        const string scenePath = "Assets/OpenMasuSyntheticProbe.unity";
        EditorSceneManager.SaveScene(scene, scenePath);
        EditorUserBuildSettings.SwitchActiveBuildTarget(BuildTargetGroup.Android, BuildTarget.Android);
        PlayerSettings.SetApplicationIdentifier(NamedBuildTarget.Android, "dev.openmasu.synthetic.probe");
        PlayerSettings.Android.minSdkVersion = AndroidSdkVersions.AndroidApiLevel25;
        EditorUserBuildSettings.exportAsGoogleAndroidProject = true;
        var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions {
            scenes = new[] { scenePath }, locationPathName = output, target = BuildTarget.Android,
            options = BuildOptions.AcceptExternalModificationsToPlayer | BuildOptions.StrictMode });
        if (report.summary.result != BuildResult.Succeeded)
            throw new BuildFailedException($"OpenMasu probe export failed: {report.summary.result}");
        Debug.Log("OPENMASU_ANDROID_EXPORT_PROBE_OK");
    }

    private static string Argument(string name)
    {
        var arguments = Environment.GetCommandLineArgs();
        for (var index = 0; index < arguments.Length - 1; index++)
            if (arguments[index] == name) return Path.GetFullPath(arguments[index + 1]);
        return string.Empty;
    }
}
'''


def blocking_unity(path: Path) -> Path:
    if os.name == "nt" and path.suffix.lower() == ".exe":
        console = path.with_suffix(".com")
        if console.is_file():
            return console
    return path


def run(command: list[str], *, cwd: Path, timeout: int = 900) -> None:
    subprocess.run(command, cwd=cwd, check=True, timeout=timeout)


def run_captured(
    command: list[str],
    *,
    cwd: Path,
    environment: dict[str, str],
    timeout: int = 900,
) -> None:
    completed = subprocess.run(
        command,
        cwd=cwd,
        env=environment,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
    )
    if completed.returncode != 0:
        tail = "\n".join(completed.stdout.splitlines()[-80:])
        raise RuntimeError(f"Unity Android Gradle build failed:\n{tail}")


def gradle_command(gradle: Path, arguments: list[str]) -> list[str]:
    if os.name == "nt" and gradle.suffix.lower() == ".bat":
        return ["cmd.exe", "/d", "/c", str(gradle), *arguments]
    return [str(gradle), *arguments]


def validate_export(export: Path, *, expect_links: bool) -> tuple[int, int]:
    manifest_path = export / "unityLibrary/src/main/AndroidManifest.xml"
    settings_path = export / "settings.gradle"
    if not manifest_path.is_file() or not settings_path.is_file():
        raise RuntimeError("Unity Android Gradle export is incomplete")
    document = ET.parse(manifest_path)
    application = document.getroot().find("application")
    if application is None:
        raise RuntimeError("Unity Android application manifest is missing")
    filters = []
    for activity in application.findall("activity"):
        for intent_filter in activity.findall("intent-filter"):
            if intent_filter.get(ANDROID_NAMESPACE + "label") == LINK_LABEL:
                filters.append(intent_filter)
    hosts = sorted(
        data.get(ANDROID_NAMESPACE + "host")
        for intent_filter in filters
        for data in intent_filter.findall("data")
        if data.get(ANDROID_NAMESPACE + "host") is not None
    )
    expected_hosts = list(SYNTHETIC_HOSTS) if expect_links else []
    if hosts != expected_hosts:
        raise RuntimeError(f"Unity Android App Links differ: {hosts}")
    metadata = [
        value
        for value in application.findall("meta-data")
        if value.get(ANDROID_NAMESPACE + "name") == LINK_METADATA
    ]
    if expect_links:
        if len(metadata) != 1 or metadata[0].get(ANDROID_NAMESPACE + "value") != ",".join(SYNTHETIC_HOSTS):
            raise RuntimeError("Unity Android App Links metadata differs")
    elif metadata:
        raise RuntimeError("Unity Android App Links metadata exists without settings")
    settings = settings_path.read_text(encoding="utf-8")
    if settings.count("OPENMASU_PACKAGED_MAVEN_BEGIN") != 1 or settings.count(
        "OPENMASU_PACKAGED_MAVEN_END"
    ) != 1:
        raise RuntimeError("Unity Gradle settings do not contain one packaged Maven repository")
    modules = export / "unityLibrary/OpenMasu.androidlib/maven/dev/openmasu"
    module_count = len([path for path in modules.iterdir() if path.is_dir()])
    if module_count != 4:
        raise RuntimeError(f"Unity export contains {module_count} OpenMasu Android modules")
    return len(filters), module_count


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run a synthetic Unity 6 UPM import, Android export, and Gradle build"
    )
    parser.add_argument("--unity", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument(
        "--without-settings",
        action="store_true",
        help="Omit optional App Links settings while still requiring packaged dependency resolution",
    )
    parser.add_argument(
        "--gradle",
        type=Path,
        default=ROOT / "sdk/android" / ("gradlew.bat" if os.name == "nt" else "gradlew"),
    )
    arguments = parser.parse_args()
    unity = blocking_unity(arguments.unity.resolve())
    bundle = arguments.bundle.resolve()
    manifest = json.loads((bundle / "release-manifest.json").read_text(encoding="utf-8"))
    version = str(manifest["version"])
    package_archive = bundle / f"com.openmasu.sdk-{version}.tgz"
    if not unity.is_file() or not package_archive.is_file() or not arguments.gradle.resolve().is_file():
        raise RuntimeError("Unity, release UPM archive, or Gradle wrapper is missing")

    unity_version = subprocess.check_output([str(unity), "-version"], text=True).strip()
    with tempfile.TemporaryDirectory(prefix="openmasu-unity-export-") as temporary:
        temporary_root = Path(temporary)
        project = temporary_root / "project"
        export = temporary_root / "export"
        create_log = temporary_root / "create.log"
        build_log = temporary_root / "build.log"
        run(
            [
                str(unity), "-batchmode", "-nographics", "-quit", "-createProject", str(project),
                "-logFile", str(create_log),
            ],
            cwd=ROOT,
        )
        package_manifest = json.loads((project / "Packages/manifest.json").read_text(encoding="utf-8"))
        package_manifest["dependencies"]["com.openmasu.sdk"] = "file:" + package_archive.as_posix()
        (project / "Packages/manifest.json").write_text(
            json.dumps(package_manifest, indent=2) + "\n", encoding="utf-8", newline="\n"
        )
        editor = project / "Assets/Editor"
        editor.mkdir(parents=True, exist_ok=True)
        (editor / "OpenMasuAndroidExportProbe.cs").write_text(
            EDITOR_SCRIPT, encoding="utf-8", newline="\n"
        )
        if not arguments.without_settings:
            (project / "ProjectSettings/OpenMasuAndroidSettings.json").write_text(
                json.dumps(
                    {
                        "linkHosts": list(SYNTHETIC_HOSTS),
                        "activityName": "com.unity3d.player.UnityPlayerActivity",
                    },
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
                newline="\n",
            )
        run(
            [
                str(unity), "-batchmode", "-nographics", "-quit", "-projectPath", str(project),
                "-buildTarget", "Android", "-executeMethod", "OpenMasuAndroidExportProbe.Build",
                "-openmasuProbeOut", str(export), "-logFile", str(build_log),
            ],
            cwd=ROOT,
        )
        log = build_log.read_text(encoding="utf-8", errors="replace")
        if "OPENMASU_ANDROID_EXPORT_PROBE_OK" not in log:
            raise RuntimeError("Unity Android export success marker is missing")
        immutable_warnings = [
            line.strip()
            for line in log.splitlines()
            if "has no meta file, but it's in an immutable folder" in line
        ]
        if immutable_warnings:
            raise RuntimeError(
                "Unity ignored immutable UPM package assets without metadata: "
                + repr(immutable_warnings[:20])
            )
        filter_count, module_count = validate_export(
            export, expect_links=not arguments.without_settings
        )

        environment = os.environ.copy()
        editor_root = arguments.unity.resolve().parent
        embedded_java = editor_root / "Data/PlaybackEngines/AndroidPlayer/OpenJDK"
        if embedded_java.is_dir():
            environment["JAVA_HOME"] = str(embedded_java)
        run_captured(
            gradle_command(
                arguments.gradle.resolve(),
                ["-p", str(export), ":launcher:assembleDebug", "--no-daemon"],
            ),
            cwd=ROOT,
            environment=environment,
            timeout=900,
        )
        apks = list((export / "launcher/build/outputs/apk/debug").glob("*.apk"))
        if len(apks) != 1 or apks[0].stat().st_size == 0:
            raise RuntimeError("Unity Android Gradle build output is missing")
        evidence = {
            "apk_bytes": apks[0].stat().st_size,
            "app_link_filters": filter_count,
            "openmasu_android_modules": module_count,
            "package_version": version,
            "settings_present": not arguments.without_settings,
            "synthetic_only": True,
            "unity_version": unity_version,
        }
    print(json.dumps(evidence, sort_keys=True))


if __name__ == "__main__":
    main()
