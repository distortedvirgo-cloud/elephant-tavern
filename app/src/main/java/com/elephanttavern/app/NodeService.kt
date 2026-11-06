package com.elephanttavern.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.Process
import android.util.Log
import java.io.File

/**
 * Runs SillyTavern on the embedded Node.js runtime.
 *
 * Lives in its own process (":node"): node can only be started once per
 * process, so restarting the server means killing this process and starting
 * the service again — the chat UI process keeps running.
 */
class NodeService : Service() {

    companion object {
        private const val TAG = "ElephantNode"
        private const val CHANNEL = "server"
        private const val NOTIFICATION_ID = 1
        const val ACTION_STOP = "com.elephanttavern.app.STOP"

        @Volatile
        private var started = false

        fun start(context: Context) {
            val intent = Intent(context, NodeService::class.java)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        }
    }

    private lateinit var paths: AppPaths

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        paths = AppPaths(this)
        goForeground(getString(R.string.app_name), "Запуск сервера…")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            ServerStatus.write(paths, ServerStatus(ServerStatus.EXITED, message = "Сервер остановлен"))
            stopForeground(STOP_FOREGROUND_REMOVE)
            Process.killProcess(Process.myPid())
            return START_NOT_STICKY
        }
        if (!started) {
            started = true
            Thread({ boot() }, "elephant-boot").start()
        }
        return START_STICKY
    }

    private fun status(s: ServerStatus) = ServerStatus.write(paths, s.copy(pid = Process.myPid()))

    private fun boot() {
        try {
            applyPendingRestore()
            status(ServerStatus(ServerStatus.INSTALLING, 0f, message = "Распаковка SillyTavern…"))
            var lastShown = -1
            val st = TavernInstaller.ensure(this, paths) { p ->
                val pct = (p * 100).toInt()
                if (pct != lastShown) {
                    lastShown = pct
                    status(ServerStatus(ServerStatus.INSTALLING, p, message = "Распаковка SillyTavern… $pct%"))
                }
            }

            val port = Net.choosePort()
            listOf(paths.data, paths.logs, paths.tmp, paths.compileCache).forEach { it.mkdirs() }
            status(ServerStatus(ServerStatus.STARTING, port = port, message = "Запуск Node.js…"))

            val env = arrayOf(
                "HOME", paths.data.absolutePath,
                "TMPDIR", paths.tmp.absolutePath,
                "NODE_ENV", "production",
                "NODE_COMPILE_CACHE", paths.compileCache.absolutePath,
                "NODE_COMPILE_CACHE_PORTABLE", "1",
                "NODE_OPTIONS", "--max-old-space-size=1024",
                "UV_THREADPOOL_SIZE", "4",
                "FORCE_COLOR", "0",
                "ET_DATA", paths.data.absolutePath,
                "ET_PORT", port.toString(),
                "ET_LOG", paths.log.absolutePath,
                "ET_OUTBOX", paths.outbox.absolutePath,
                "TZ", java.util.TimeZone.getDefault().id,
                "ET_APP_VERSION", BuildConfigCompat.versionName(this),
            )
            val args = arrayOf("node", File(st, "elephant-boot.mjs").absolutePath)

            // Generous stack: the main thread of desktop node gets 8 MB.
            Thread(null, {
                val code = try {
                    NodeBridge.startNode(args, env)
                } catch (t: Throwable) {
                    Log.e(TAG, "node crashed", t)
                    -1
                }
                status(ServerStatus(ServerStatus.EXITED, port = port, message = "Node.js завершился (код $code)"))
                updateNotification("Сервер остановлен")
            }, "node", 16L * 1024 * 1024).start()

            waitUntilReady(port)
        } catch (t: Throwable) {
            Log.e(TAG, "boot failed", t)
            status(ServerStatus(ServerStatus.FAILED, message = t.message ?: t.toString()))
            updateNotification("Ошибка запуска")
        }
    }

    private fun waitUntilReady(port: Int) {
        val deadline = System.currentTimeMillis() + 5 * 60_000
        while (System.currentTimeMillis() < deadline) {
            val current = ServerStatus.read(paths)
            if (current.phase == ServerStatus.EXITED) return
            if (Net.ping(port)) {
                status(ServerStatus(ServerStatus.READY, 1f, port, "Готово"))
                updateNotification("Сервер работает")
                Thread({ watchOutbox() }, "elephant-outbox").start()
                return
            }
            val line = LogTail.lastLine(paths.log)
            status(ServerStatus(ServerStatus.STARTING, port = port, message = line.ifBlank { "Запуск Node.js…" }))
            Thread.sleep(400)
        }
        status(ServerStatus(ServerStatus.FAILED, port = port, message = "Сервер не ответил за 5 минут"))
    }

    /** Messages the server wrote on its own (a character writing first) become notifications. */
    private fun watchOutbox() {
        paths.outbox.mkdirs()
        while (true) {
            try {
                paths.outbox.listFiles { f -> f.name.endsWith(".json") }?.sortedBy { it.lastModified() }?.forEach { f ->
                    try {
                        MessageNotifier.show(this, org.json.JSONObject(f.readText()))
                    } catch (e: Exception) {
                        Log.w(TAG, "bad outbox item ${f.name}", e)
                    }
                    f.delete()
                }
            } catch (e: Exception) {
                Log.w(TAG, "outbox", e)
            }
            Thread.sleep(15_000)
        }
    }

    /** A backup restore is staged by the UI; it is swapped in before node touches the data folder. */
    private fun applyPendingRestore() {
        val staged = paths.dataImport
        if (!File(staged, ".complete").exists()) {
            if (staged.exists()) staged.deleteRecursively()
            return
        }
        val old = File(paths.data.parentFile, "data-before-restore")
        old.deleteRecursively()
        if (paths.data.exists()) paths.data.renameTo(old)
        File(staged, ".complete").delete()
        staged.renameTo(paths.data)
        old.deleteRecursively()
    }

    // --- notification ------------------------------------------------------

    private fun buildNotification(title: String, text: String): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "Локальный сервер", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Пока сервер работает, чат продолжает генерацию в фоне"
                    setShowBadge(false)
                },
            )
        }
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, NodeService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
        return builder
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "Остановить", stop).build())
            .build()
    }

    private fun goForeground(title: String, text: String) {
        val n = buildNotification(title, text)
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, n)
        }
    }

    private fun updateNotification(text: String) {
        try {
            getSystemService(NotificationManager::class.java)
                .notify(NOTIFICATION_ID, buildNotification(getString(R.string.app_name), text))
        } catch (_: Exception) {
        }
    }
}

object BuildConfigCompat {
    fun versionName(context: Context): String = try {
        context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "?"
    } catch (_: Exception) {
        "?"
    }
}
