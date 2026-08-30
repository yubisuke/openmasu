from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import re
import shutil
import subprocess
import tarfile
import tempfile
import uuid
import zipfile
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
FIXED_ZIP_TIME = (1980, 1, 1, 0, 0, 0)
MODULES = {
    "core": [
        ("org.jetbrains.kotlin", "kotlin-stdlib", "2.3.0", "compile", False),
        ("androidx.room", "room-runtime", "2.8.4", "runtime", False),
        ("androidx.work", "work-runtime", "2.11.2", "runtime", False),
    ],
    "installreferrer": [
        ("dev.openmasu", "core", "0.2.0-rc.4", "compile", False),
        ("com.android.installreferrer", "installreferrer", "2.2", "runtime", False),
    ],
    "metareferrer": [("dev.openmasu", "core", "0.2.0-rc.4", "compile", False)],
    "max": [
        ("dev.openmasu", "core", "0.2.0-rc.4", "compile", False),
        ("com.applovin", "applovin-sdk", "13.6.2", "provided", True),
    ],
    "unitybridge": [
        ("dev.openmasu", "core", "0.2.0-rc.4", "compile", False),
        ("dev.openmasu", "installreferrer", "0.2.0-rc.4", "runtime", False),
        ("dev.openmasu", "metareferrer", "0.2.0-rc.4", "runtime", False),
        ("dev.openmasu", "max", "0.2.0-rc.4", "compile", False),
    ],
}
UPM_ANDROID_MODULES = ("core", "installreferrer", "metareferrer", "max")


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def source_revision() -> str:
    return subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, encoding="utf-8"
    ).strip()


def tracked_files(prefix: str) -> list[Path]:
    output = subprocess.check_output(
        ["git", "ls-files", "--", prefix], cwd=ROOT, text=True, encoding="utf-8"
    )
    return [ROOT / value for value in output.splitlines() if value]


def sdk_version() -> str:
    android = read_text(ROOT / "sdk/android/build.gradle.kts")
    match = re.search(r'^version = "([^"]+)"$', android, re.MULTILINE)
    if not match:
        raise RuntimeError("Android SDK version is unavailable")
    unity = json.loads(read_text(ROOT / "sdk/unity/com.openmasu.sdk/package.json"))["version"]
    if unity != match.group(1):
        raise RuntimeError(f"SDK version mismatch: Android={match.group(1)} Unity={unity}")
    return unity


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")


def normalize_zip(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(source, "r") as input_zip, zipfile.ZipFile(
        destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9
    ) as output_zip:
        for name in sorted(input_zip.namelist()):
            source_info = input_zip.getinfo(name)
            info = zipfile.ZipInfo(name, FIXED_ZIP_TIME)
            info.compress_type = zipfile.ZIP_STORED if name.endswith("/") else zipfile.ZIP_DEFLATED
            info.external_attr = (0o40755 if name.endswith("/") else 0o100644) << 16
            info.create_system = 3
            output_zip.writestr(info, b"" if name.endswith("/") else input_zip.read(source_info))


def write_source_zip(destination: Path, files: list[Path], prefix: str) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for source in sorted(files):
            relative = source.relative_to(ROOT).as_posix()
            info = zipfile.ZipInfo(f"{prefix}/{relative}", FIXED_ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            info.create_system = 3
            archive.writestr(info, source.read_bytes())


def write_upm_archive(
    destination: Path,
    files: list[Path],
    additional_files: dict[str, Path] | None = None,
) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    package_root = ROOT / "sdk/unity/com.openmasu.sdk"
    entries = {
        source.relative_to(package_root).as_posix(): source
        for source in files
    }
    entries.update(additional_files or {})
    with destination.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=9) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.GNU_FORMAT) as archive:
                for relative, source in sorted(entries.items()):
                    info = tarfile.TarInfo(f"package/{relative}")
                    data = source.read_bytes()
                    info.size = len(data)
                    info.mode = 0o644
                    info.mtime = 0
                    info.uid = info.gid = 0
                    info.uname = info.gname = ""
                    import io
                    archive.addfile(info, io.BytesIO(data))


def pom_xml(artifact: str, version: str) -> str:
    dependencies = []
    for group, name, dependency_version, scope, optional in MODULES[artifact]:
        resolved_version = version if group == "dev.openmasu" else dependency_version
        optional_xml = "\n      <optional>true</optional>" if optional else ""
        dependencies.append(
            "    <dependency>\n"
            f"      <groupId>{group}</groupId>\n"
            f"      <artifactId>{name}</artifactId>\n"
            f"      <version>{resolved_version}</version>\n"
            f"      <scope>{scope}</scope>{optional_xml}\n"
            "    </dependency>"
        )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<project xmlns="http://maven.apache.org/POM/4.0.0" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
        'xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 '
        'https://maven.apache.org/xsd/maven-4.0.0.xsd">\n'
        "  <modelVersion>4.0.0</modelVersion>\n"
        "  <groupId>dev.openmasu</groupId>\n"
        f"  <artifactId>{artifact}</artifactId>\n"
        f"  <version>{version}</version>\n"
        "  <packaging>aar</packaging>\n"
        "  <name>OpenMasu Android SDK</name>\n"
        "  <url>https://github.com/yubisuke/openmasu</url>\n"
        "  <licenses><license><name>Apache License, Version 2.0</name>"
        "<url>https://www.apache.org/licenses/LICENSE-2.0.txt</url></license></licenses>\n"
        "  <dependencies>\n"
        + "\n".join(dependencies)
        + "\n  </dependencies>\n</project>\n"
    )


def normalize_sbom(source: Path, destination: Path, revision: str) -> None:
    value = json.loads(read_text(source))
    value.pop("serialNumber", None)
    metadata = value.get("metadata")
    if isinstance(metadata, dict):
        metadata.pop("timestamp", None)
    stable_name = f"{destination.name}:{revision}"
    value["serialNumber"] = f"urn:uuid:{uuid.uuid5(uuid.NAMESPACE_URL, stable_name)}"
    write_json(destination, value)


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def build_bundle(output_root: Path) -> Path:
    version = sdk_version()
    revision = source_revision()
    output = output_root / f"openmasu-sdk-{version}"
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    for legal_name in ("LICENSE", "NOTICE"):
        shutil.copyfile(ROOT / legal_name, output / legal_name)

    for artifact in MODULES:
        module = "../unity/com.openmasu.sdk/Runtime/OpenMasu.androidlib" if artifact == "unitybridge" else artifact
        candidates = sorted((ROOT / "sdk/android" / module / "build/outputs/aar").glob("*-release.aar"))
        if len(candidates) != 1:
            raise RuntimeError(f"Expected one release AAR for {artifact}; found {len(candidates)}")
        target = output / "maven/dev/openmasu" / artifact / version
        normalize_zip(candidates[0], target / f"{artifact}-{version}.aar")
        (target / f"{artifact}-{version}.pom").write_text(
            pom_xml(artifact, version), encoding="utf-8", newline="\n"
        )

    packaged_maven = {}
    for artifact in UPM_ANDROID_MODULES:
        artifact_root = output / "maven/dev/openmasu" / artifact / version
        for source in sorted(artifact_root.iterdir()):
            relative = source.relative_to(output / "maven").as_posix()
            packaged_maven[f"Runtime/OpenMasu.androidlib/maven/{relative}"] = source
    write_upm_archive(
        output / f"com.openmasu.sdk-{version}.tgz",
        tracked_files("sdk/unity/com.openmasu.sdk"),
        packaged_maven,
    )
    write_source_zip(
        output / f"OpenMasuIOS-{version}-source.zip",
        tracked_files("sdk/ios"),
        f"OpenMasuIOS-{version}",
    )
    for name in ("sdk-android.cdx.json", "sdk-ios.cdx.json", "sdk-unity.cdx.json"):
        source = ROOT / "sbom" / name
        if not source.is_file():
            raise RuntimeError(f"Missing {source}; generate SDK SBOMs first")
        normalize_sbom(source, output / "sbom" / name, revision)

    manifest = {
        "format": "openmasu-sdk-release-v1",
        "version": version,
        "source_revision": revision,
        "artifacts": sorted(
            path.relative_to(output).as_posix()
            for path in output.rglob("*") if path.is_file()
        ),
        "inputs": {
            "android_gradle_plugin": "8.13.2",
            "gradle": "8.13",
            "java": "17",
            "kotlin": "2.3.0",
            "node": read_text(ROOT / ".nvmrc").strip(),
            "npm": json.loads(read_text(ROOT / "package.json"))["engines"]["npm"],
            "python": read_text(ROOT / ".python-version").strip(),
            "swift_tools": "5.9",
        },
        "commands": [
            "npm ci",
            "npm run sbom",
            "./sdk/android/gradlew -p sdk/android :core:assembleRelease :installreferrer:assembleRelease :metareferrer:assembleRelease :max:assembleRelease :unitybridge:assembleRelease verifySdkSbom --no-daemon",
            "python tools/build-sdk-release.py --reproducibility-check",
            "python tools/verify-unity-upm.py",
        ],
    }
    write_json(output / "release-manifest.json", manifest)
    checksum_paths = sorted(path for path in output.rglob("*") if path.is_file())
    (output / "SHA256SUMS").write_text(
        "".join(f"{file_hash(path)}  {path.relative_to(output).as_posix()}\n" for path in checksum_paths),
        encoding="utf-8", newline="\n",
    )
    verify_bundle(output)
    return output


def verify_bundle(output: Path) -> None:
    manifest = json.loads(read_text(output / "release-manifest.json"))
    version = manifest["version"]
    expected = {
        f"maven/dev/openmasu/{name}/{version}/{name}-{version}.{suffix}"
        for name in MODULES for suffix in ("aar", "pom")
    }
    expected.update({
        f"com.openmasu.sdk-{version}.tgz",
        f"OpenMasuIOS-{version}-source.zip",
        "sbom/sdk-android.cdx.json",
        "sbom/sdk-ios.cdx.json",
        "sbom/sdk-unity.cdx.json",
        "release-manifest.json",
        "LICENSE",
        "NOTICE",
    })
    actual = {path.relative_to(output).as_posix() for path in output.rglob("*") if path.is_file()}
    if actual != expected | {"SHA256SUMS"}:
        raise RuntimeError(f"Release contents differ: missing={sorted(expected - actual)} extra={sorted(actual - expected - {'SHA256SUMS'})}")
    checksum_lines = read_text(output / "SHA256SUMS").splitlines()
    seen: set[str] = set()
    for line in checksum_lines:
        digest, relative = line.split("  ", 1)
        path = output / relative
        if not path.is_file() or file_hash(path) != digest:
            raise RuntimeError(f"Checksum mismatch: {relative}")
        seen.add(relative)
    if seen != actual - {"SHA256SUMS"}:
        raise RuntimeError("Checksum manifest coverage differs from release files")
    with tarfile.open(output / f"com.openmasu.sdk-{version}.tgz", "r:gz") as archive:
        names = set(archive.getnames())
        if "package/package.json" not in names or not any(name.startswith("package/Runtime/") for name in names):
            raise RuntimeError("UPM archive is incomplete")
        if any("/build/" in name or name.endswith("/.env") for name in names):
            raise RuntimeError("UPM archive contains generated or secret material")
        expected_packaged_maven = {
            f"package/Runtime/OpenMasu.androidlib/maven/dev/openmasu/{name}/{version}/{name}-{version}.{suffix}"
            for name in UPM_ANDROID_MODULES for suffix in ("aar", "pom")
        }
        if not expected_packaged_maven.issubset(names):
            raise RuntimeError(
                "UPM archive is missing packaged Android dependencies: "
                + repr(sorted(expected_packaged_maven - names))
            )
        if any("/maven/dev/openmasu/unitybridge/" in name for name in names):
            raise RuntimeError("UPM archive must not duplicate the Unity bridge AAR")
        for name in UPM_ANDROID_MODULES:
            for suffix in ("aar", "pom"):
                archive_name = (
                    f"package/Runtime/OpenMasu.androidlib/maven/dev/openmasu/{name}/{version}/"
                    f"{name}-{version}.{suffix}"
                )
                member = archive.extractfile(archive_name)
                if member is None:
                    raise RuntimeError(f"UPM Android dependency is unreadable: {archive_name}")
                outside = output / "maven/dev/openmasu" / name / version / f"{name}-{version}.{suffix}"
                if hashlib.sha256(member.read()).digest() != hashlib.sha256(outside.read_bytes()).digest():
                    raise RuntimeError(f"UPM Android dependency differs from Maven bundle: {archive_name}")
    with zipfile.ZipFile(output / f"OpenMasuIOS-{version}-source.zip") as archive:
        names = set(archive.namelist())
        if not any(name.endswith("/sdk/ios/Package.swift") for name in names):
            raise RuntimeError("Swift source archive is incomplete")
        if any("/.build/" in name or "/build/" in name for name in names):
            raise RuntimeError("Swift source archive contains generated output")
    for sbom in (output / "sbom").glob("*.json"):
        if json.loads(read_text(sbom)).get("bomFormat") != "CycloneDX":
            raise RuntimeError(f"Invalid CycloneDX SBOM: {sbom.name}")


def compare_trees(first: Path, second: Path) -> None:
    left = {path.relative_to(first).as_posix(): file_hash(path) for path in first.rglob("*") if path.is_file()}
    right = {path.relative_to(second).as_posix(): file_hash(path) for path in second.rglob("*") if path.is_file()}
    if left != right:
        changed = sorted(set(left) | set(right))
        raise RuntimeError(f"SDK release bundle is not reproducible: {changed}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build and verify the reproducible OpenMasu SDK release bundle")
    parser.add_argument("--output", type=Path, default=ROOT / "build/sdk-release")
    parser.add_argument("--verify-only", type=Path)
    parser.add_argument("--reproducibility-check", action="store_true")
    arguments = parser.parse_args()
    if arguments.verify_only:
        verify_bundle(arguments.verify_only.resolve())
        print(f"Verified SDK release bundle: {arguments.verify_only}")
        return
    if arguments.reproducibility_check:
        with tempfile.TemporaryDirectory(prefix="openmasu-sdk-release-") as temporary:
            temporary_root = Path(temporary)
            first = build_bundle(temporary_root / "first")
            second = build_bundle(temporary_root / "second")
            compare_trees(first, second)
    output = build_bundle(arguments.output.resolve())
    print(f"Built reproducible SDK release bundle: {output}")


if __name__ == "__main__":
    main()
