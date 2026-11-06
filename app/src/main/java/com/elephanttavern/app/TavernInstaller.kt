package com.elephanttavern.app

import android.content.Context
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.util.zip.ZipInputStream

/**
 * Unpacks the SillyTavern bundle (assets/tavern.zip) into filesDir/tavern/<build>.
 * User data lives elsewhere (AppPaths.data), so a new bundle simply replaces the old one.
 */
object TavernInstaller {

    data class BundleInfo(val stVersion: String, val build: String, val entries: Int, val elephantMemory: String)

    fun bundleInfo(context: Context): BundleInfo {
        val json = context.assets.open("tavern.json").bufferedReader().use { it.readText() }
        val o = JSONObject(json)
        return BundleInfo(
            o.optString("stVersion", "?"), o.optString("build", "dev"),
            o.optInt("entries", 20000), o.optString("elephantMemory", "?"),
        )
    }

    /** Returns the SillyTavern directory, unpacking it first if needed. */
    fun ensure(context: Context, paths: AppPaths, onProgress: (Float) -> Unit): File {
        val info = bundleInfo(context)
        val target = File(paths.tavernRoot, info.build)
        val marker = File(target, ".installed")
        if (marker.exists()) return target

        paths.tavernRoot.mkdirs()
        val staging = File(paths.tavernRoot, "${info.build}.partial")
        staging.deleteRecursively()
        staging.mkdirs()

        val buffer = ByteArray(256 * 1024)
        var done = 0
        val canonicalStaging = staging.canonicalPath + File.separator
        ZipInputStream(BufferedInputStream(context.assets.open("tavern.zip"), 512 * 1024)).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: break
                val out = File(staging, entry.name)
                if (!out.canonicalPath.startsWith(canonicalStaging)) continue // zip-slip guard
                if (entry.isDirectory) {
                    out.mkdirs()
                } else {
                    out.parentFile?.mkdirs()
                    FileOutputStream(out).use { fos ->
                        while (true) {
                            val n = zip.read(buffer)
                            if (n <= 0) break
                            fos.write(buffer, 0, n)
                        }
                    }
                }
                done++
                if (done % 250 == 0) onProgress((done.toFloat() / info.entries).coerceAtMost(0.99f))
            }
        }

        target.deleteRecursively()
        if (!staging.renameTo(target)) error("Could not move the unpacked bundle into place")
        marker.writeText(info.stVersion)
        onProgress(1f)

        // Old builds are dead weight (~350 MB each).
        paths.tavernRoot.listFiles()?.forEach { if (it.name != info.build) it.deleteRecursively() }
        return target
    }
}
