plugins {
  id("com.android.library")
  id("org.jetbrains.kotlin.android")
  id("com.google.devtools.ksp")
}

android {
  namespace = "dev.openmmp.sdk"
  compileSdk = 36
  defaultConfig {
    minSdk = 24
    consumerProguardFiles("consumer-rules.pro")
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  testOptions { unitTests.isIncludeAndroidResources = true }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }
ksp { arg("room.schemaLocation", file("schemas").absolutePath) }

dependencies {
  implementation("androidx.room:room-runtime:2.8.4")
  ksp("androidx.room:room-compiler:2.8.4")
  implementation("androidx.work:work-runtime:2.11.2")
  testImplementation("junit:junit:4.13.2")
  testImplementation("androidx.test:core:1.7.0")
  testImplementation("org.robolectric:robolectric:4.16.1")
  androidTestImplementation("androidx.test:runner:1.7.0")
  androidTestImplementation("androidx.test.ext:junit:1.3.0")
}
