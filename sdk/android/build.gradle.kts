plugins {
  id("com.android.library") version "8.13.2" apply false
  id("com.android.application") version "8.13.2" apply false
  id("org.jetbrains.kotlin.android") version "2.3.0" apply false
  id("com.google.devtools.ksp") version "2.3.10" apply false
  id("org.cyclonedx.bom") version "3.3.0"
}

group = "dev.openmasu"
version = "0.1.0"

tasks.register("verifySdkSbom") {
  dependsOn("cyclonedxBom")
  doLast {
    val candidates = listOf(
      layout.buildDirectory.file("reports/cyclonedx/bom.json").get().asFile,
      layout.buildDirectory.file("reports/bom.json").get().asFile,
    )
    val source = candidates.firstOrNull { it.isFile }
      ?: throw GradleException("CycloneDX did not produce a JSON SBOM")
    val destination = rootProject.file("../../sbom/sdk-android.cdx.json")
    destination.parentFile.mkdirs()
    source.copyTo(destination, overwrite = true)
    check(destination.length() > 0L) { "Android SBOM is empty" }
  }
}

tasks.register("androidAcceptance") {
  dependsOn(
    ":core:testDebugUnitTest",
    ":installreferrer:compileDebugKotlin",
    ":metareferrer:testDebugUnitTest",
    ":max:testDebugUnitTest",
    ":sample:assembleDebug",
    ":sample:verifyMergedManifest",
    ":unitybridge:assembleDebug",
    "verifyDeepLinkPolicy",
  )
}

tasks.register("verifyDeepLinkPolicy") {
  dependsOn(":core:assembleDebug", ":sample:assembleDebug")
  doLast {
    val forbidden = listOf("AdvertisingIdClient", "getAdvertisingIdInfo", "Build.FINGERPRINT", "startActivity(")
    val sources = rootProject.fileTree(rootProject.projectDir) {
      include("**/*.kt", "**/*.java")
      exclude("**/build/**")
    }
    forbidden.forEach { symbol ->
      check(sources.none { it.readText().contains(symbol) }) { "DL-A-14 forbidden Android source symbol: $symbol" }
    }
    val built = files(
      rootProject.fileTree(rootProject.file("core/build")) { include("**/*.class", "**/*.jar") },
      rootProject.fileTree(rootProject.file("installreferrer/build")) { include("**/*.class", "**/*.jar") },
    )
    forbidden.dropLast(1).forEach { symbol ->
      check(built.none { String(it.readBytes(), Charsets.ISO_8859_1).contains(symbol) }) {
        "DL-A-14 forbidden Android built symbol: $symbol"
      }
    }
    println("DL-A-14 Android source and built-symbol audit passed")
  }
}
