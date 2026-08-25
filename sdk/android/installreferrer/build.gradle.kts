plugins {
  id("com.android.library")
  id("org.jetbrains.kotlin.android")
}

android {
  namespace = "dev.openmasu.sdk.installreferrer"
  compileSdk = 36
  defaultConfig { minSdk = 24 }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
  api(project(":core"))
  implementation("com.android.installreferrer:installreferrer:2.2")
  testImplementation("junit:junit:4.13.2")
}
