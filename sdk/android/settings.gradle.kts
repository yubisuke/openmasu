pluginManagement {
  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }
}

dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
  repositories {
    google()
    mavenCentral()
  }
}

rootProject.name = "openmasu-android"
include(":core", ":installreferrer", ":metareferrer", ":max", ":sample")
include(":unitybridge")
project(":unitybridge").projectDir = file("../unity/com.openmasu.sdk/Runtime/OpenMasu.androidlib")
