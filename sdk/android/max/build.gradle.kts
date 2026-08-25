plugins {
  id("com.android.library")
  id("org.jetbrains.kotlin.android")
}

android {
  namespace = "dev.openmasu.sdk.max"
  compileSdk = 36
  defaultConfig { minSdk = 24 }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  testOptions { unitTests.isIncludeAndroidResources = true }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
  api(project(":core"))
  compileOnly("com.applovin:applovin-sdk:13.6.2")
  testImplementation("junit:junit:4.13.2")
  testImplementation("org.robolectric:robolectric:4.16.1")
}
