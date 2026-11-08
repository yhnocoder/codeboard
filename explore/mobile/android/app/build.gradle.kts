import com.android.build.api.variant.ApplicationAndroidComponentsExtension

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
    androidResources {
        // tiles are WebP already: storing them uncompressed lets them be read straight from the APK
        noCompress += listOf("webp", "json")
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("com.google.android.material:material:1.12.0")
    testImplementation("junit:junit:4.13.2")
}

// The board tiles: ../tiles-out (the renderer's output) when it exists, otherwise fake-tiles
// (tools/fake_tiles.py). -PboardsDir=<dir> picks another folder. They land in the APK as assets/boards/.
val boardsSource: File = (findProperty("boardsDir") as String?)?.let { rootDir.resolve(it) }
    ?: rootDir.resolve("../tiles-out").takeIf { it.resolve("index.json").exists() }
    ?: rootDir.resolve("fake-tiles")

abstract class CopyBoards : DefaultTask() {
    @get:InputDirectory
    abstract val source: DirectoryProperty

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun run() {
        val src = source.get().asFile
        if (!src.resolve("index.json").exists()) {
            throw GradleException("No index.json in $src: run `python3 tools/fake_tiles.py` or pass -PboardsDir=<dir>")
        }
        val out = outputDir.get().asFile
        out.deleteRecursively()
        // only what the app reads: index.json, manifests and the WebP tiles (not leftovers of older formats)
        src.walkTopDown().filter { it.isFile && (it.extension == "webp" || it.extension == "json") }.forEach {
            it.copyTo(out.resolve("boards").resolve(it.relativeTo(src)), overwrite = true)
        }
    }
}

val copyBoards = tasks.register<CopyBoards>("copyBoards") {
    source.set(boardsSource)
    outputDir.set(layout.buildDirectory.dir("generated/boardAssets"))
}

extensions.getByType(ApplicationAndroidComponentsExtension::class.java).onVariants { variant ->
    variant.sources.assets?.addGeneratedSourceDirectory(copyBoards, CopyBoards::outputDir)
}

// The APK next to the project, where it is picked up for sideloading.
tasks.register("apk") {
    dependsOn("assembleDebug")
    val built = layout.buildDirectory.file("outputs/apk/debug/app-debug.apk")
    val target = rootDir.resolve("CodeBoard.apk")
    doLast { built.get().asFile.copyTo(target, overwrite = true) }
}
