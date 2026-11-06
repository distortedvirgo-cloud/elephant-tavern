plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

val ciVersionCode = System.getenv("ET_VERSION_CODE")?.toIntOrNull()
val ciVersionName = System.getenv("ET_VERSION_NAME")

android {
    namespace = "com.elephanttavern.app"
    compileSdk = 35
    ndkVersion = "27.2.12479018"

    defaultConfig {
        applicationId = "com.elephanttavern.app"
        minSdk = 26
        targetSdk = 35
        versionCode = ciVersionCode ?: 1
        versionName = ciVersionName ?: "0.1.0-dev"

        ndk {
            abiFilters += listOf("arm64-v8a")
        }
        externalNativeBuild {
            cmake {
                arguments += listOf("-DANDROID_STL=c++_shared")
            }
        }
    }

    // One stable key (from CI secrets), so every build installs over the previous one.
    // Without it, release builds fall back to the local debug key.
    val keystorePath = System.getenv("ET_KEYSTORE")
    val keystorePassword = System.getenv("ET_KEYSTORE_PASSWORD")
    val hasReleaseKey = !keystorePath.isNullOrBlank() && file(keystorePath).exists() && !keystorePassword.isNullOrBlank()
    signingConfigs {
        if (hasReleaseKey) {
            create("release") {
                storeFile = file(keystorePath!!)
                storePassword = keystorePassword
                keyAlias = System.getenv("ET_KEY_ALIAS") ?: "elephant"
                keyPassword = keystorePassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (hasReleaseKey) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    sourceSets {
        getByName("main") {
            jniLibs.srcDirs("libnode/bin")
        }
    }

    androidResources {
        // tavern.zip is already compressed; storing it avoids a second inflate pass.
        noCompress += listOf("zip")
    }

    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
}
