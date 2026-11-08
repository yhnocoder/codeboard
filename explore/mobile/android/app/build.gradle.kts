plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.github.yhnocoder.codeboard"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.yhnocoder.codeboard"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
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
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.security:security-crypto:1.0.0")
    testImplementation("junit:junit:4.13.2")
    // the real org.json in JVM tests (android.jar has only stubs)
    testImplementation("org.json:json:20240303")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}

// The APK next to the project, where it is picked up for sideloading.
tasks.register("apk") {
    dependsOn("assembleDebug")
    val built = layout.buildDirectory.file("outputs/apk/debug/app-debug.apk")
    val target = rootDir.resolve("CodeBoard.apk")
    doLast { built.get().asFile.copyTo(target, overwrite = true) }
}
