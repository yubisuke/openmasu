"""Exercise a downloaded Android SDK against a disposable loopback backend.

This helper never builds SDK source. Only the standalone consumer is compiled;
all dev.openmasu dependencies must resolve from the verified bundle's Maven tree.
Credentials, raw Gradle logs, Android state, and reports are never retained or
printed. Failures expose only allowlisted, redacted compiler/stack diagnostics.
"""

from __future__ import annotations

import argparse
import importlib.util
import ipaddress
import json
import os
import re
import shutil
import signal
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit


ROOT = Path(__file__).resolve().parents[1]
TEST_CLASS = "dev.openmasu.consumer.PublishedSdkTest"
TEST_METHOD = "publishedCoreDeliversNativeEvents"
KEY_VARIABLES = ("OPENMASU_SYNTHETIC_SDK_KEY_ID", "OPENMASU_SYNTHETIC_SDK_SECRET")
PINS = {"android_gradle_plugin": "8.13.2", "gradle": "8.13", "java": "17", "kotlin": "2.3.0"}
ENVIRONMENT_ALLOWLIST = {
    "ANDROID_HOME", "ANDROID_SDK_ROOT", "APPDATA", "CI", "COMSPEC",
    "HOME", "HOMEDRIVE", "HOMEPATH", "JAVA_HOME", "LOCALAPPDATA", "LOGNAME", "PATH",
    "PATHEXT", "PROCESSOR_ARCHITECTURE", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "USER",
    "USERNAME", "USERPROFILE", "WINDIR",
}


class ConsumerFailure(RuntimeError):
    """A fixed, non-sensitive reason suitable for the aggregate report."""

    def __init__(self, reason: str, diagnostics: list[str] | None = None) -> None:
        super().__init__(reason)
        self.diagnostics = diagnostics or []


def loopback_endpoint(value: str) -> str:
    try:
        url = urlsplit(value)
        host = url.hostname
        port = url.port
        if (
            url.scheme != "http" or not host or port is None or not 1 <= port <= 65535
            or url.username is not None or url.password is not None
            or url.path not in ("", "/") or url.query or url.fragment
        ):
            raise ValueError
        # Avoid DNS resolution, including a potentially overridden localhost entry.
        address = ipaddress.ip_address("127.0.0.1" if host == "localhost" else host)
        if not address.is_loopback or "%" in host:
            raise ValueError
        authority = f"[{address}]:{port}" if address.version == 6 else f"{address}:{port}"
        return urlunsplit(("http", authority, "", "", ""))
    except ValueError:
        raise ConsumerFailure("endpoint_must_be_http_loopback_with_explicit_port") from None


def verified_identity(bundle: Path) -> tuple[str, str]:
    if not bundle.is_dir() or any(path.is_symlink() for path in bundle.rglob("*")):
        raise ConsumerFailure("bundle_directory_missing_or_contains_symlinks")
    try:
        manifest = json.loads((bundle / "release-manifest.json").read_text(encoding="utf-8"))
        version = manifest["version"]
        if not isinstance(version, str) or re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?", version) is None:
            raise ValueError
        if any(manifest.get("inputs", {}).get(key) != pin for key, pin in PINS.items()):
            raise ConsumerFailure("bundle_toolchain_pin_mismatch")
        spec = importlib.util.spec_from_file_location("openmasu_release_verifier", ROOT / "tools/build-sdk-release.py")
        if spec is None or spec.loader is None:
            raise ValueError
        verifier = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(verifier)
        # Deliberately call the read-only verifier, never its source build/main path.
        verifier.verify_bundle(bundle, expected_version=version)
        return version, manifest["source_revision"]
    except ConsumerFailure:
        raise
    except Exception:
        raise ConsumerFailure("downloaded_bundle_verification_failed") from None


def groovy_string(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def write_consumer(consumer: Path, bundle: Path, version: str) -> None:
    files = {
        "settings.gradle": """pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        exclusiveContent {
            forRepository {
                maven {
                    name = 'downloadedOpenMasuSdk'
                    url = uri(MAVEN_URI)
                }
            }
            filter { includeGroup 'dev.openmasu' }
        }
    }
}
rootProject.name = 'openmasu-published-sdk-consumer'
""".replace("MAVEN_URI", groovy_string((bundle / "maven").as_uri())),
        "build.gradle": """plugins {
    id 'com.android.library' version '8.13.2'
    id 'org.jetbrains.kotlin.android' version '2.3.0'
}
android {
    namespace = 'dev.openmasu.consumer'
    compileSdk = 36
    defaultConfig { minSdk = 24 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    testOptions { unitTests.includeAndroidResources = true }
}
kotlin { compilerOptions { jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17 } }
dependencies {
    implementation 'dev.openmasu:core:SDK_VERSION'
    testImplementation 'junit:junit:4.13.2'
    testImplementation 'androidx.test:core:1.7.0'
    testImplementation 'org.robolectric:robolectric:4.16.1'
}
tasks.withType(Test).configureEach {
    maxParallelForks = 1
    systemProperty 'java.io.tmpdir', file('runtime').absolutePath
    systemProperty 'user.home', file('runtime').absolutePath
    testLogging { showStandardStreams = false }
}
""".replace("SDK_VERSION", version),
        "gradle.properties": "android.useAndroidX=true\norg.gradle.daemon=false\norg.gradle.caching=false\nkotlin.compiler.execution.strategy=in-process\n",
        "src/main/AndroidManifest.xml": """<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <application android:usesCleartextTraffic="true" />
</manifest>
""",
    }
    for relative, content in files.items():
        path = consumer / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8", newline="\n")
    (consumer / "runtime").mkdir()
    test = consumer / "src/test/java/dev/openmasu/consumer/PublishedSdkTest.kt"
    test.parent.mkdir(parents=True)
    shutil.copyfile(ROOT / "tools/sdk-consumer/PublishedSdkTest.kt", test)


def child_environment(endpoint: str) -> dict[str, str]:
    environment = {key: value for key, value in os.environ.items() if key.upper() in ENVIRONMENT_ALLOWLIST}
    for key in KEY_VARIABLES:
        value = os.environ.get(key)
        if not value or not value.strip() or len(value) > 4096 or any(char in value for char in "\r\n\0"):
            raise ConsumerFailure("synthetic_sdk_credentials_missing_or_invalid")
        environment[key] = value
    environment["OPENMASU_SYNTHETIC_SDK_ENDPOINT"] = endpoint
    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    if not sdk or not (Path(sdk) / "platforms/android-36/android.jar").is_file():
        raise ConsumerFailure("android_sdk_36_required_via_android_home_or_android_sdk_root")
    return environment


def terminate_tree(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False, timeout=15,
        )
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if process.poll() is None:
        process.kill()
    process.wait(timeout=15)


def safe_diagnostics(consumer: Path, environment: dict[str, str]) -> list[str]:
    """Allowlist compiler locations and stack frames; never publish raw logs/XML."""
    diagnostics: list[str] = []
    compiler_line = re.compile(
        r"^(?:e: (?:file:/{1,3})?.*PublishedSdkTest\.kt:[0-9]+|"
        r".*build\.gradle:[0-9]+:|Execution failed for task ':?[A-Za-z0-9:]+')"
    )
    log = consumer / "gradle-private.log"
    if log.is_file():
        for line in log.read_text(encoding="utf-8", errors="replace").splitlines():
            if compiler_line.match(line):
                diagnostics.append(line[:500])
                if len(diagnostics) >= 8:
                    break
    report = consumer / f"build/test-results/testDebugUnitTest/TEST-{TEST_CLASS}.xml"
    if report.is_file():
        try:
            for case in ET.parse(report).getroot().findall("testcase"):
                if case.get("classname") != TEST_CLASS or case.get("name") != TEST_METHOD:
                    continue
                for failure in [*case.findall("failure"), *case.findall("error")]:
                    kind = failure.get("type", "")
                    if re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_.$]*", kind):
                        diagnostics.append(f"{TEST_CLASS}.{TEST_METHOD}: {kind}")
                    for line in (failure.text or "").splitlines():
                        if re.fullmatch(r"\s+at [A-Za-z_$][A-Za-z0-9_.$]*\([A-Za-z0-9_.$: +~-]+\)", line):
                            diagnostics.append(line.strip())
                            if len(diagnostics) >= 16:
                                break
        except ET.ParseError:
            diagnostics.append("native_test_report_unreadable")
    redacted: list[str] = []
    for line in diagnostics[:16]:
        for key in (*KEY_VARIABLES, "OPENMASU_SYNTHETIC_SDK_ENDPOINT"):
            line = line.replace(environment[key], "[redacted]")
        line = line.replace(str(consumer), "<consumer>").replace(consumer.as_posix(), "<consumer>")
        line = line.replace(str(ROOT), "<repository>").replace(ROOT.as_posix(), "<repository>")
        redacted.append(line)
    return redacted


def run_consumer(consumer: Path, environment: dict[str, str], timeout_seconds: int) -> None:
    gradle = ROOT / "sdk/android" / ("gradlew.bat" if os.name == "nt" else "gradlew")
    properties = (ROOT / "sdk/android/gradle/wrapper/gradle-wrapper.properties").read_text(encoding="utf-8")
    if (
        not gradle.is_file()
        or "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.13-bin.zip" not in properties.splitlines()
        or "distributionSha256Sum=20f1b1176237254a6fc204d8434196fa11a4cfb387567519c61556e8710aed78" not in properties.splitlines()
    ):
        raise ConsumerFailure("pinned_gradle_wrapper_missing_or_changed")
    command = [str(gradle), "-p", str(consumer), "testDebugUnitTest", "--tests", f"{TEST_CLASS}.{TEST_METHOD}", "--no-daemon", "--no-build-cache", "--no-configuration-cache", "--console=plain"]
    if os.name == "nt":
        command = ["cmd.exe", "/d", "/c", *command]
    # Isolate caches, daemon logs, and user init scripts as well as the project.
    # A clean consumer must not inherit an already-resolved OpenMasu artifact.
    environment = {**environment, "GRADLE_USER_HOME": str(consumer / "gradle-user-home")}
    # Keep raw output private, including failures; never echo payloads or credentials.
    with (consumer / "gradle-private.log").open("wb") as output:
        process = subprocess.Popen(
            command, cwd=consumer, env=environment, stdout=output, stderr=subprocess.STDOUT,
            start_new_session=os.name != "nt",
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
        )
        try:
            try:
                returncode = process.wait(timeout=timeout_seconds)
            except subprocess.TimeoutExpired:
                raise ConsumerFailure("consumer_process_timeout") from None
        finally:
            terminate_tree(process)
    if returncode != 0:
        raise ConsumerFailure("consumer_gradle_or_native_test_failed", safe_diagnostics(consumer, environment))
    report = consumer / f"build/test-results/testDebugUnitTest/TEST-{TEST_CLASS}.xml"
    if not report.is_file():
        raise ConsumerFailure("native_test_report_missing")
    suite = ET.parse(report).getroot()
    cases = suite.findall("testcase")
    if (
        suite.get("tests") != "1" or suite.get("failures") != "0" or suite.get("errors") != "0"
        or len(cases) != 1 or cases[0].get("name") != TEST_METHOD
        or cases[0].find("skipped") is not None
    ):
        raise ConsumerFailure("native_test_report_did_not_confirm_one_passing_test")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True, help="Downloaded, extracted release bundle directory")
    parser.add_argument("--endpoint", required=True, help="Disposable backend HTTP loopback origin with an explicit port")
    parser.add_argument("--timeout-seconds", type=int, default=600)
    arguments = parser.parse_args()
    try:
        if not 60 <= arguments.timeout_seconds <= 1200:
            raise ConsumerFailure("timeout_seconds_must_be_between_60_and_1200")
        endpoint = loopback_endpoint(arguments.endpoint)
        environment = child_environment(endpoint)
        bundle = arguments.bundle.resolve()
        version, source_revision = verified_identity(bundle)
        with tempfile.TemporaryDirectory(prefix="openmasu-published-sdk-consumer-") as temporary:
            consumer = Path(temporary)
            write_consumer(consumer, bundle, version)
            run_consumer(consumer, environment, arguments.timeout_seconds)
    except ConsumerFailure as error:
        print(json.dumps({"status": "failed", "reason": str(error), "diagnostics": error.diagnostics}, sort_keys=True))
        return 1
    except Exception:
        print(json.dumps({"status": "failed", "reason": "consumer_setup_or_cleanup_failed"}, sort_keys=True))
        return 1
    print(json.dumps({"status": "passed", "sdk_version": version, "source_revision": source_revision, "native_tests": 1, "requested_sdk_events": 5, "pending_events": 0}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
