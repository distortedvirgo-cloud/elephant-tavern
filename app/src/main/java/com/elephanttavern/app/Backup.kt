package com.elephanttavern.app

import android.content.Context
import android.net.Uri
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

/** Whole-data backup: characters, chats, settings, secrets, images — as one zip. */
object Backup {

    private val skipTopLevel = setOf("_cache", "_webpack", "_uploads", "_storage")

    fun export(context: Context, paths: AppPaths, target: Uri): Int {
        var files = 0
        val root = paths.data
        context.contentResolver.openOutputStream(target)?.use { raw ->
            ZipOutputStream(BufferedOutputStream(raw, 256 * 1024)).use { zip ->
                zip.setLevel(5)
                root.walkTopDown()
                    .onEnter { dir -> dir == root || dir.parentFile != root || dir.name !in skipTopLevel }
                    .filter { it.isFile }
                    .forEach { f ->
                        val name = f.relativeTo(root).invariantSeparatorsPath
                        zip.putNextEntry(ZipEntry("data/$name").apply { time = f.lastModified() })
                        FileInputStream(f).use { it.copyTo(zip, 128 * 1024) }
                        zip.closeEntry()
                        files++
                    }
            }
        } ?: error("Не удалось открыть файл для записи")
        return files
    }

    /**
     * Unpacks a backup into the staging folder. Accepts our own backups
     * (entries under data/) and plain SillyTavern data zips (default-user/...).
     */
    fun stageImport(context: Context, paths: AppPaths, source: Uri): Int {
        val staging = paths.dataImport
        staging.deleteRecursively()
        staging.mkdirs()
        val canonical = staging.canonicalPath + File.separator
        var files = 0
        context.contentResolver.openInputStream(source)?.use { raw ->
            ZipInputStream(BufferedInputStream(raw, 256 * 1024)).use { zip ->
                while (true) {
                    val entry = zip.nextEntry ?: break
                    var name = entry.name.replace('\\', '/')
                    name = when {
                        name.startsWith("data/") -> name.removePrefix("data/")
                        name.contains("/data/default-user/") -> name.substringAfter("/data/")
                        else -> name
                    }
                    if (name.isBlank()) continue
                    val out = File(staging, name)
                    if (!out.canonicalPath.startsWith(canonical)) continue
                    if (entry.isDirectory) {
                        out.mkdirs()
                        continue
                    }
                    out.parentFile?.mkdirs()
                    FileOutputStream(out).use { zip.copyTo(it, 128 * 1024) }
                    files++
                }
            }
        } ?: error("Не удалось открыть файл")
        if (files == 0 || !File(staging, "default-user").exists()) {
            staging.deleteRecursively()
            error("В архиве нет папки default-user — это не бэкап SillyTavern")
        }
        File(staging, ".complete").writeText("ok")
        return files
    }
}
