plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

android {
  namespace = "dev.openmasu.sample"
  compileSdk = 36
  defaultConfig {
    applicationId = "dev.openmasu.sample"
    minSdk = 24
    targetSdk = 36
    versionCode = 1
    versionName = "0.1.0"
    manifestPlaceholders["OPENMASU_LINK_HOST"] = "links.synthetic.invalid"
    manifestPlaceholders["OPENMASU_LINK_SCHEME"] = "openmasu-synthetic"
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
  implementation(project(":core"))
  implementation(project(":installreferrer"))
  implementation(project(":metareferrer"))
  implementation(project(":max"))
  debugImplementation("com.applovin:applovin-sdk:13.6.2")
  debugImplementation("androidx.room:room-runtime:2.8.4")
  androidTestImplementation("androidx.test:runner:1.7.0")
  androidTestImplementation("androidx.test.ext:junit:1.3.0")
  androidTestImplementation("androidx.room:room-runtime:2.8.4")
}

tasks.register("verifyMergedManifest") {
  dependsOn("processDebugMainManifest")
  doLast {
    val manifests = fileTree(layout.buildDirectory) {
      include("intermediates/merged_manifest/debug/**/AndroidManifest.xml")
    }.files
    val manifest = manifests.firstOrNull() ?: throw GradleException("Merged debug manifest was not produced")
    val text = manifest.readText()
    listOf("com.facebook.katana", "com.instagram.android", "com.facebook.lite").forEach {
      check(text.contains("android:name=\"$it\"")) { "Merged manifest is missing Meta query package $it" }
    }
    check(text.contains("android:dataExtractionRules=\"@xml/openmasu_data_extraction_rules\""))
    check(text.contains("android:fullBackupContent=\"@xml/openmasu_backup_rules\""))
    val modern = project(":core").file("src/main/res/xml/openmasu_data_extraction_rules.xml").readText()
    check(modern.contains("<cloud-backup>"))
    check(modern.contains("<device-transfer>"))
    check(modern.windowed(32, 1, partialWindows = true).any { it.contains("openmasu_private.xml") })
    check(modern.contains("path=\"openmasu\""))
    val legacy = project(":core").file("src/main/res/xml/openmasu_backup_rules.xml").readText()
    check(legacy.contains("openmasu_private.xml") && legacy.contains("path=\"openmasu\""))
    listOf("android.intent.action.VIEW", "android.intent.category.BROWSABLE", "android:autoVerify=\"true\"",
      "android:scheme=\"https\"", "android:host=\"links.synthetic.invalid\"", "android:pathPrefix=\"/r/\"").forEach {
      check(text.contains(it)) { "DL-A-20 merged manifest is missing $it" }
    }
    val androidNs = "http://schemas.android.com/apk/res/android"
    val document = javax.xml.parsers.DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
      .newDocumentBuilder().parse(manifest)
    val filters = document.getElementsByTagName("intent-filter")
    val verified = (0 until filters.length).map { filters.item(it) as org.w3c.dom.Element }
      .singleOrNull { it.getAttributeNS(androidNs, "autoVerify") == "true" }
      ?: throw GradleException("DL-A-20 merged manifest must contain exactly one autoVerify filter")
    fun attributes(tag: String, attribute: String): Set<String> {
      val nodes = verified.getElementsByTagName(tag)
      return (0 until nodes.length).mapNotNull {
        (nodes.item(it) as org.w3c.dom.Element).getAttributeNS(androidNs, attribute).takeIf(String::isNotEmpty)
      }.toSet()
    }
    check(attributes("action", "name") == setOf("android.intent.action.VIEW"))
    check(attributes("category", "name").containsAll(setOf("android.intent.category.DEFAULT", "android.intent.category.BROWSABLE")))
    check(attributes("data", "scheme") == setOf("http", "https")) {
      "DL-A-20 custom schemes must remain outside the autoVerify filter"
    }
    check(attributes("data", "host") == setOf("links.synthetic.invalid"))
    println("A-12/A-13 merged manifest and backup exclusions verified: ${manifest.relativeTo(rootProject.projectDir)}")
  }
}
