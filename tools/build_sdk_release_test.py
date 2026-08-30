from __future__ import annotations

import importlib.util
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("build-sdk-release.py")
SPEC = importlib.util.spec_from_file_location("openmasu_build_sdk_release", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load {SCRIPT}")
RELEASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RELEASE)
POM_NAMESPACE = {"m": "http://maven.apache.org/POM/4.0.0"}


def pom_dependencies(artifact: str, version: str) -> dict[tuple[str, str], str]:
    root = ET.fromstring(RELEASE.pom_xml(artifact, version))
    result: dict[tuple[str, str], str] = {}
    for dependency in root.findall("m:dependencies/m:dependency", POM_NAMESPACE):
        group = dependency.findtext("m:groupId", namespaces=POM_NAMESPACE)
        name = dependency.findtext("m:artifactId", namespaces=POM_NAMESPACE)
        dependency_version = dependency.findtext("m:version", namespaces=POM_NAMESPACE)
        if group is None or name is None or dependency_version is None:
            raise AssertionError("Generated POM dependency is incomplete")
        result[(group, name)] = dependency_version
    return result


class SdkReleaseDependencyVersionTests(unittest.TestCase):
    def test_internal_dependencies_use_the_generated_release_version(self) -> None:
        future_version = "9.8.7-future.1"
        for artifact, definitions in RELEASE.MODULES.items():
            generated = pom_dependencies(artifact, future_version)
            for group, name, configured_version, _scope, _optional in definitions:
                if group == "dev.openmasu":
                    self.assertIsNone(configured_version, f"{artifact}:{name}")
                    self.assertEqual(generated[(group, name)], future_version, f"{artifact}:{name}")

    def test_external_dependencies_preserve_their_explicit_pins(self) -> None:
        for artifact, definitions in RELEASE.MODULES.items():
            generated = pom_dependencies(artifact, "9.8.7-future.1")
            for group, name, configured_version, _scope, _optional in definitions:
                if group != "dev.openmasu":
                    self.assertIsNotNone(configured_version, f"{artifact}:{group}:{name}")
                    self.assertEqual(generated[(group, name)], configured_version, f"{artifact}:{group}:{name}")

    def test_static_internal_versions_are_rejected(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "must use the generated release version"):
            RELEASE.resolved_dependency_version("dev.openmasu", "core", "stale-version", "future-version")

    def test_release_worktree_rejects_every_tracked_or_untracked_change(self) -> None:
        status = " M sbom/sdk-ios.cdx.json\n M sdk/android/build.gradle.kts\n?? private.txt\n"
        self.assertEqual(
            RELEASE.unexpected_release_changes(status),
            [
                " M sbom/sdk-ios.cdx.json",
                " M sdk/android/build.gradle.kts",
                "?? private.txt",
            ],
        )

    def test_manifest_identity_must_match_the_candidate_source(self) -> None:
        revision = "a" * 40
        manifest = {
            "format": "openmasu-sdk-release-v1",
            "version": "0.2.0",
            "source_revision": revision,
        }
        self.assertEqual(
            RELEASE.verify_manifest_identity(
                manifest,
                expected_revision=revision,
                expected_version="0.2.0",
            ),
            ("0.2.0", revision),
        )
        with self.assertRaisesRegex(RuntimeError, "manifest revision differs"):
            RELEASE.verify_manifest_identity(
                manifest,
                expected_revision="b" * 40,
                expected_version="0.2.0",
            )

    def test_release_tag_must_be_annotated_and_target_the_bundle_revision(self) -> None:
        revision = "a" * 40
        with patch.object(RELEASE.subprocess, "check_output", side_effect=["tag\n", f"{revision}\n"]):
            RELEASE.verify_release_tag("0.2.0", revision)
        with patch.object(RELEASE.subprocess, "check_output", return_value="commit\n"):
            with self.assertRaisesRegex(RuntimeError, "not annotated"):
                RELEASE.verify_release_tag("0.2.0", revision)

    def test_release_inputs_are_regenerated_before_packaging(self) -> None:
        with patch.object(RELEASE.os, "name", "nt"), patch.object(
            RELEASE.subprocess, "run"
        ) as run:
            RELEASE.prepare_release_inputs()
        self.assertEqual(run.call_count, 2)
        self.assertEqual(run.call_args_list[0].args[0], ["npm.cmd", "run", "sbom"])
        gradle = run.call_args_list[1].args[0]
        self.assertTrue(str(gradle[0]).endswith("gradlew.bat"))
        self.assertIn("clean", gradle)
        self.assertIn("androidAcceptance", gradle)
        self.assertIn("verifySdkSbom", gradle)
        self.assertTrue(run.call_args_list[0].kwargs["check"])
        self.assertTrue(run.call_args_list[1].kwargs["check"])


if __name__ == "__main__":
    unittest.main()
