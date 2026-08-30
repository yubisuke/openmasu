from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import tarfile
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ANDROID_MODULES = ("core", "installreferrer", "metareferrer", "max")


def release_version() -> str:
    package = json.loads(
        (ROOT / "sdk/unity/com.openmasu.sdk/package.json").read_text(encoding="utf-8")
    )
    return str(package["version"])


def validate_metadata(package_root: Path) -> None:
    required: list[Path] = [package_root / "package.json.meta"]
    for root_name in ("Editor", "Runtime", "Samples~"):
        root = package_root / root_name
        required.append(root.with_name(root.name + ".meta"))
        for path in root.rglob("*"):
            if path == package_root / "Runtime/OpenMasu.androidlib" or (
                package_root / "Runtime/OpenMasu.androidlib" in path.parents
            ):
                continue
            if path.suffix == ".meta":
                continue
            required.append(path.with_name(path.name + ".meta"))
    missing = sorted(path.relative_to(package_root).as_posix() for path in required if not path.is_file())
    if missing:
        raise RuntimeError(f"Unity package metadata is incomplete: {missing}")

    guid_pattern = re.compile(r"\AfileFormatVersion: 2\s+guid: ([0-9a-f]{32})\s*\Z")
    seen: set[str] = set()
    for path in sorted(set(required)):
        match = guid_pattern.fullmatch(path.read_text(encoding="utf-8"))
        if not match:
            raise RuntimeError(f"Unity metadata is invalid: {path.relative_to(package_root)}")
        guid = match.group(1)
        asset = path.relative_to(package_root).as_posix()[:-5]
        expected = hashlib.sha256(
            f"openmasu-unity-meta:{asset}".encode("utf-8")
        ).hexdigest()[:32]
        if guid != expected:
            raise RuntimeError(f"Unity metadata GUID is not deterministic: {asset}")
        if guid in seen:
            raise RuntimeError(f"Unity metadata GUID is duplicated: {guid}")
        seen.add(guid)


def write_consumer(consumer: Path, package_root: Path) -> None:
    agp_source = (ROOT / "sdk/android/build.gradle.kts").read_text(encoding="utf-8")
    match = re.search(r'id\("com\.android\.library"\) version "([^"]+)"', agp_source)
    if not match:
        raise RuntimeError("Android Gradle Plugin version is unavailable")
    agp = match.group(1)
    (consumer / "build.gradle").write_text(
        "plugins {\n"
        f"    id 'com.android.library' version '{agp}' apply false\n"
        "}\n",
        encoding="utf-8",
        newline="\n",
    )
    (consumer / "gradle.properties").write_text(
        "android.useAndroidX=true\n",
        encoding="utf-8",
        newline="\n",
    )
    module = package_root / "Runtime/OpenMasu.androidlib"
    module_path = module.as_posix().replace("'", "\\'")
    (consumer / "settings.gradle").write_text(
        "pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }\n"
        "include ':OpenMasu.androidlib'\n"
        f"project(':OpenMasu.androidlib').projectDir = file('{module_path}')\n"
        "dependencyResolutionManagement {\n"
        "    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)\n"
        "    repositories {\n"
        "        google()\n"
        "        mavenCentral()\n"
        "        exclusiveContent {\n"
        "            forRepository {\n"
        "                maven {\n"
        "                    name = 'openMasuPackaged'\n"
        f"                    url = uri(new File('{module_path}', 'maven'))\n"
        "                }\n"
        "            }\n"
        "            filter { includeGroup 'dev.openmasu' }\n"
        "        }\n"
        "    }\n"
        "}\n",
        encoding="utf-8",
        newline="\n",
    )


def gradle_command(gradle: Path, arguments: list[str]) -> list[str]:
    if os.name == "nt" and gradle.suffix.lower() == ".bat":
        return ["cmd.exe", "/d", "/c", str(gradle), *arguments]
    return [str(gradle), *arguments]


def main() -> None:
    version = release_version()
    parser = argparse.ArgumentParser(
        description="Verify standalone Android resolution from the generated Unity UPM package"
    )
    parser.add_argument(
        "--bundle",
        type=Path,
        default=ROOT / "build/sdk-release" / f"openmasu-sdk-{version}",
    )
    parser.add_argument(
        "--gradle",
        type=Path,
        default=ROOT / "sdk/android" / ("gradlew.bat" if os.name == "nt" else "gradlew"),
    )
    arguments = parser.parse_args()
    bundle = arguments.bundle.resolve()
    archive_path = bundle / f"com.openmasu.sdk-{version}.tgz"
    if not archive_path.is_file():
        raise RuntimeError(f"Unity UPM archive is missing: {archive_path}")
    if not arguments.gradle.resolve().is_file():
        raise RuntimeError(f"Gradle wrapper is missing: {arguments.gradle}")

    with tempfile.TemporaryDirectory(prefix="openmasu-unity-upm-") as temporary:
        temporary_root = Path(temporary)
        with tarfile.open(archive_path, "r:gz") as archive:
            for member in archive.getmembers():
                parts = Path(member.name).parts
                if not parts or parts[0] != "package" or ".." in parts:
                    raise RuntimeError(f"Unsafe Unity archive entry: {member.name}")
            archive.extractall(temporary_root, filter="data")
        package_root = temporary_root / "package"
        validate_metadata(package_root)

        maven = package_root / "Runtime/OpenMasu.androidlib/maven/dev/openmasu"
        missing_modules = [name for name in ANDROID_MODULES if not (maven / name / version).is_dir()]
        if missing_modules:
            raise RuntimeError(f"Unity UPM package is missing Android modules: {missing_modules}")
        if (maven / "unitybridge").exists():
            raise RuntimeError("Unity UPM package duplicates the source bridge as an AAR")

        consumer = temporary_root / "consumer"
        consumer.mkdir()
        write_consumer(consumer, package_root)
        subprocess.run(
            gradle_command(
                arguments.gradle.resolve(),
                ["-p", str(consumer), ":OpenMasu.androidlib:assembleRelease", "--no-daemon"],
            ),
            cwd=ROOT,
            check=True,
        )
        outputs = list((package_root / "Runtime/OpenMasu.androidlib/build/outputs/aar").glob("*-release.aar"))
        if len(outputs) != 1 or outputs[0].stat().st_size == 0:
            raise RuntimeError("Standalone Unity Android library output is missing")

    print(
        "Verified standalone Unity UPM Android resolution for "
        f"{len(ANDROID_MODULES)} packaged OpenMasu modules ({version})."
    )


if __name__ == "__main__":
    main()
