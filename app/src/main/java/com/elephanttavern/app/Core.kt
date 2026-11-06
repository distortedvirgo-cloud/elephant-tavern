package com.elephanttavern.app

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.URL

/** JNI entry into the embedded Node.js runtime (only ever used in the :node process). */
object NodeBridge {
    init {
        System.loadLibrary("native-lib")
    }

    /** Blocks until node exits. env is a flat [key, value, key, value, ...] array. */
    @JvmStatic
    external fun startNode(args: Array<String>, env: Array<String>): Int
}

/** All on-device locations in one place. */
class AppPaths(context: Context) {
    private val files: File = context.filesDir
    val tavernRoot = File(files, "tavern")          // unpacked SillyTavern builds, one per bundle id
    val data = File(files, "data")                  // user data — survives app updates
    val dataImport = File(files, "data-import")     // staged backup restore, swapped in on next start
    val logs = File(files, "logs")
    val log = File(logs, "server.log")
    val status = File(files, "status.json")
    val tmp = File(context.cacheDir, "tmp")
    val compileCache = File(context.cacheDir, "node-compile-cache")
}

/**
 * Server status, written by the :node process and read by the UI process.
 * A small JSON file is the simplest IPC that survives either side restarting.
 */
data class ServerStatus(
    val phase: String,           // idle | installing | starting | ready | failed | exited
    val progress: Float = 0f,
    val port: Int = 0,
    val message: String = "",
    val pid: Int = 0,
    val time: Long = System.currentTimeMillis(),
) {
    fun toJson(): String = JSONObject()
        .put("phase", phase).put("progress", progress.toDouble()).put("port", port)
        .put("message", message).put("pid", pid).put("time", time).toString()

    companion object {
        const val IDLE = "idle"
        const val INSTALLING = "installing"
        const val STARTING = "starting"
        const val READY = "ready"
        const val FAILED = "failed"
        const val EXITED = "exited"

        fun read(paths: AppPaths): ServerStatus {
            return try {
                val o = JSONObject(paths.status.readText())
                ServerStatus(
                    o.optString("phase", IDLE), o.optDouble("progress", 0.0).toFloat(),
                    o.optInt("port"), o.optString("message"), o.optInt("pid"), o.optLong("time"),
                )
            } catch (_: Exception) {
                ServerStatus(IDLE)
            }
        }

        fun write(paths: AppPaths, status: ServerStatus) {
            try {
                val tmp = File(paths.status.parentFile, "status.json.tmp")
                tmp.writeText(status.toJson())
                tmp.renameTo(paths.status)
            } catch (_: Exception) {
            }
        }
    }
}

object Net {
    const val PREFERRED_PORT = 8642

    fun isPortFree(port: Int): Boolean = try {
        ServerSocket().use { it.reuseAddress = true; it.bind(InetSocketAddress("127.0.0.1", port)) }
        true
    } catch (_: Exception) {
        false
    }

    fun choosePort(): Int {
        for (p in PREFERRED_PORT until PREFERRED_PORT + 20) if (isPortFree(p)) return p
        return ServerSocket(0).use { it.localPort }
    }

    /** True when SillyTavern answers on the port. */
    fun ping(port: Int, timeoutMs: Int = 1500): Boolean = try {
        val c = URL("http://127.0.0.1:$port/").openConnection() as HttpURLConnection
        c.connectTimeout = timeoutMs
        c.readTimeout = timeoutMs
        c.instanceFollowRedirects = false
        val code = c.responseCode
        c.disconnect()
        code in 200..399 || code == 401
    } catch (_: Exception) {
        false
    }
}

object LogTail {
    fun read(file: File, maxBytes: Int = 16 * 1024): String {
        if (!file.exists()) return ""
        return try {
            RandomAccessFile(file, "r").use { raf ->
                val len = raf.length()
                val start = (len - maxBytes).coerceAtLeast(0)
                raf.seek(start)
                val bytes = ByteArray((len - start).toInt())
                raf.readFully(bytes)
                String(bytes, Charsets.UTF_8).let { if (start > 0) it.substringAfter('\n') else it }
            }
        } catch (_: Exception) {
            ""
        }
    }

    fun lastLine(file: File): String =
        read(file, 2048).trimEnd().lineSequence().lastOrNull { it.isNotBlank() }?.trim().orEmpty()
}
