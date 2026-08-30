from __future__ import annotations

import importlib.util
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path


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


if __name__ == "__main__":
    unittest.main()
