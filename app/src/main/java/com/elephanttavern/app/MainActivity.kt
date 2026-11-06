package com.elephanttavern.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.ActivityManager
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.Process
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Hosts the SillyTavern UI in a WebView pointed at the local server that
 * [NodeService] runs in the ":node" process.
 */
class MainActivity : Activity() {

    private companion object {
        const val TAG = "ElephantTavern"
        const val REQ_FILE_CHOOSER = 10
        const val REQ_EXPORT_BACKUP = 11
        const val REQ_IMPORT_BACKUP = 12
        const val REQ_NOTIFICATIONS = 13
    }

    private lateinit var paths: AppPaths
    private lateinit var root: FrameLayout
    private lateinit var splash: SplashView
    private var webView: WebView? = null
    private var loadedPort = 0
    private var pageReady = false

    private val ui = Handler(Looper.getMainLooper())
    private val worker = HandlerThread("et-worker").apply { start() }
    private val bg = Handler(worker.looper)
    private var polling = false

    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var insetTop = 0
    private var insetBottom = 0

    // ---------------------------------------------------------------- lifecycle

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        paths = AppPaths(this)
        setupWindow()

        root = FrameLayout(this)
        splash = SplashView(this).apply {
            onRestart = { restartServer() }
            onShareLog = { shareLog() }
            onImportBackup = { pickBackupToImport() }
        }
        root.addView(splash, FrameLayout.LayoutParams(-1, -1))
        setContentView(root)
        applyInsets()

        WebView.setWebContentsDebuggingEnabled(true)
        askNotificationPermission()
        NodeService.start(this)
    }

    override fun onResume() {
        super.onResume()
        startPolling()
    }

    override fun onPause() {
        polling = false
        super.onPause()
    }

    override fun onDestroy() {
        polling = false
        webView?.destroy()
        worker.quitSafely()
        super.onDestroy()
    }

    @Deprecated("Activity API")
    override fun onBackPressed() {
        val wv = webView
        if (wv == null || !pageReady) {
            moveTaskToBack(true)
            return
        }
        wv.evaluateJavascript("(window.ElephantStage && window.ElephantStage.handleBack) ? window.ElephantStage.handleBack() : false") { result ->
            if (result != "true") moveTaskToBack(true)
        }
    }

    // ---------------------------------------------------------------- window & insets

    private fun setupWindow() {
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false)
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        }
        if (Build.VERSION.SDK_INT >= 28) {
            window.attributes.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
        if (Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
    }

    /**
     * The WebView draws under the status and navigation bars (the mood
     * background reaches the screen edges); the bar sizes go to CSS as
     * --et-safe-top / --et-safe-bottom. The keyboard shrinks the WebView.
     */
    private fun applyInsets() {
        root.setOnApplyWindowInsetsListener { v, insets ->
            val top: Int
            val nav: Int
            val ime: Int
            if (Build.VERSION.SDK_INT >= 30) {
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                top = bars.top
                nav = bars.bottom
                ime = insets.getInsets(WindowInsets.Type.ime()).bottom
            } else {
                @Suppress("DEPRECATION")
                top = insets.systemWindowInsetTop
                @Suppress("DEPRECATION")
                val bottom = insets.systemWindowInsetBottom
                val keyboard = bottom > resources.displayMetrics.heightPixels / 5
                nav = if (keyboard) 0 else bottom
                ime = if (keyboard) bottom else 0
            }
            v.setPadding(0, 0, 0, ime)
            insetTop = top
            insetBottom = if (ime > 0) 0 else nav
            splash.setInsets(top, nav)
            pushInsetsToPage()
            insets
        }
    }

    private fun pushInsetsToPage() {
        val d = resources.displayMetrics.density
        val js = "document.documentElement.style.setProperty('--et-safe-top','${(insetTop / d).toInt()}px');" +
            "document.documentElement.style.setProperty('--et-safe-bottom','${(insetBottom / d).toInt()}px');" +
            "window.dispatchEvent(new Event('et-insets'));"
        webView?.evaluateJavascript(js, null)
    }

    // ---------------------------------------------------------------- server status

    private var pingFailures = 0

    private fun startPolling() {
        if (polling) return
        polling = true
        bg.post(object : Runnable {
            override fun run() {
                if (!polling) return
                val s = ServerStatus.read(paths)
                val alive = s.phase == ServerStatus.READY && s.port > 0 && Net.ping(s.port, 2500)
                pingFailures = if (alive) 0 else pingFailures + 1
                val failures = pingFailures
                ui.post { render(s, alive, failures) }
                bg.postDelayed(this, if (webView != null && pageReady) 3000 else 350)
            }
        })
    }

    private fun render(s: ServerStatus, alive: Boolean, failures: Int) {
        val dead = s.phase == ServerStatus.FAILED || s.phase == ServerStatus.EXITED
        // While the chat is open, a busy server (big save, long sync work) must not
        // tear the page down: only a dead process or ~20 s of silence does.
        if (webView != null && !dead && (alive || failures < 7) && (loadedPort == s.port || s.phase != ServerStatus.READY)) return
        when {
            alive -> openWeb(s.port)
            dead -> {
                hideWeb()
                splash.showError(s.message.ifBlank { "Сервер не запущен" }, LogTail.read(paths.log))
            }
            s.phase == ServerStatus.INSTALLING -> {
                hideWeb()
                splash.showBooting(s.message.ifBlank { "Распаковка…" }, s.progress)
            }
            s.phase == ServerStatus.READY && failures >= 7 -> {
                hideWeb()
                splash.showError("Сервер перестал отвечать", LogTail.read(paths.log))
            }
            else -> {
                hideWeb()
                splash.showBooting(s.message.ifBlank { "Запуск сервера…" }, null)
            }
        }
    }

    private fun hideWeb() {
        webView?.let { root.removeView(it); it.destroy() }
        webView = null
        loadedPort = 0
        pageReady = false
        splash.visibility = View.VISIBLE
    }

    // ---------------------------------------------------------------- WebView

    @SuppressLint("SetJavaScriptEnabled")
    private fun openWeb(port: Int) {
        hideWeb()
        val wv = WebView(this)
        wv.setBackgroundColor(Color.parseColor("#0D0F14"))
        with(wv.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            @Suppress("DEPRECATION")
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            userAgentString = "$userAgentString ElephantTavern/${BuildConfigCompat.versionName(this@MainActivity)}"
        }
        wv.addJavascriptInterface(AppBridge(), "ElephantApp")
        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.host == "127.0.0.1" || url.host == "localhost") return false
                openExternal(url.toString())
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                pageReady = true
                view.evaluateJavascript(PAGE_SHIM, null)
                pushInsetsToPage()
                splash.animate().alpha(0f).setDuration(350).withEndAction {
                    splash.visibility = View.GONE
                    splash.alpha = 1f
                }.start()
            }

            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                Log.w(TAG, "renderer gone, crash=${detail.didCrash()}")
                hideWeb()
                return true
            }
        }
        wv.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams,
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    val accept = params.acceptTypes.filter { it.contains('/') }
                    if (accept.isNotEmpty()) putExtra(Intent.EXTRA_MIME_TYPES, accept.toTypedArray())
                    if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                }
                return try {
                    @Suppress("DEPRECATION")
                    startActivityForResult(Intent.createChooser(intent, "Выбрать файл"), REQ_FILE_CHOOSER)
                    true
                } catch (e: Exception) {
                    fileCallback = null
                    false
                }
            }

            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR) Log.w(TAG, "js: ${m.message()} @${m.sourceId()}:${m.lineNumber()}")
                return true
            }
        }
        wv.setDownloadListener { url, _, disposition, mime, _ ->
            // Same-origin downloads are fetched by the page shim; anything else opens outside.
            if (!url.startsWith("http://127.0.0.1")) openExternal(url)
            else wv.evaluateJavascript("window.__etDownload && window.__etDownload(${JSONObject.quote(url)}, ${JSONObject.quote(guessName(disposition, url))})", null)
            Log.d(TAG, "download $url $mime")
        }

        root.addView(wv, 0, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        webView = wv
        loadedPort = port
        pageReady = false
        wv.loadUrl("http://127.0.0.1:$port/")
    }

    private fun guessName(disposition: String?, url: String): String {
        val m = Regex("filename\\*?=(?:UTF-8'')?\"?([^\";]+)").find(disposition.orEmpty())
        return m?.groupValues?.get(1) ?: Uri.parse(url).lastPathSegment ?: "download"
    }

    @Deprecated("Activity API")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            REQ_FILE_CHOOSER -> {
                val result: Array<Uri>? = if (resultCode != RESULT_OK || data == null) null else {
                    val clip = data.clipData
                    if (clip != null) Array(clip.itemCount) { clip.getItemAt(it).uri }
                    else data.data?.let { arrayOf(it) }
                }
                fileCallback?.onReceiveValue(result)
                fileCallback = null
            }
            REQ_EXPORT_BACKUP -> data?.data?.takeIf { resultCode == RESULT_OK }?.let { uri ->
                toast("Сохраняю бэкап…")
                bg.post {
                    val msg = try {
                        "Бэкап сохранён: ${Backup.export(this, paths, uri)} файлов"
                    } catch (e: Exception) {
                        "Ошибка бэкапа: ${e.message}"
                    }
                    ui.post { toast(msg) }
                }
            }
            REQ_IMPORT_BACKUP -> data?.data?.takeIf { resultCode == RESULT_OK }?.let { uri ->
                toast("Читаю бэкап…")
                bg.post {
                    try {
                        val n = Backup.stageImport(this, paths, uri)
                        ui.post {
                            toast("Бэкап распакован ($n файлов). Перезапускаю сервер…")
                            restartServer()
                        }
                    } catch (e: Exception) {
                        ui.post { toast("Ошибка: ${e.message}") }
                    }
                }
            }
        }
    }

    // ---------------------------------------------------------------- actions

    private fun restartServer() {
        splash.visibility = View.VISIBLE
        splash.showBooting("Перезапуск сервера…", null)
        hideWeb()
        bg.post {
            val am = getSystemService(ActivityManager::class.java)
            am.runningAppProcesses?.filter { it.processName == "$packageName:node" }?.forEach {
                Process.killProcess(it.pid)
            }
            ServerStatus.write(paths, ServerStatus(ServerStatus.IDLE, message = "Перезапуск…"))
            Thread.sleep(700)
            ui.post { NodeService.start(this) }
        }
    }

    private fun pickBackupToImport() {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
        }
        @Suppress("DEPRECATION")
        startActivityForResult(intent, REQ_IMPORT_BACKUP)
    }

    private fun pickBackupTarget() {
        val stamp = SimpleDateFormat("yyyy-MM-dd_HH-mm", Locale.US).format(Date())
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "application/zip"
            putExtra(Intent.EXTRA_TITLE, "elephant-tavern-backup_$stamp.zip")
        }
        @Suppress("DEPRECATION")
        startActivityForResult(intent, REQ_EXPORT_BACKUP)
    }

    private fun shareLog() {
        val text = LogTail.read(paths.log, 60 * 1024)
        startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, "Elephant Tavern log")
            putExtra(Intent.EXTRA_TEXT, text)
        }, "Лог сервера"))
    }

    private fun openExternal(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (_: Exception) {
            toast("Не удалось открыть ссылку")
        }
    }

    private fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFICATIONS)
        }
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()

    private fun saveToDownloads(bytes: ByteArray, name: String, mime: String): String {
        val safe = name.replace(Regex("[\\\\/:*?\"<>|]"), "_").ifBlank { "download" }
        if (Build.VERSION.SDK_INT >= 29) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, safe)
                put(MediaStore.Downloads.MIME_TYPE, mime)
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/ElephantTavern")
            }
            val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("MediaStore")
            contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
            return "Загрузки/ElephantTavern/$safe"
        }
        val dir = File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "ElephantTavern").apply { mkdirs() }
        File(dir, safe).writeBytes(bytes)
        return File(dir, safe).absolutePath
    }

    // ---------------------------------------------------------------- JS bridge

    /** window.ElephantApp — native features for the ElephantStage UI. */
    inner class AppBridge {
        @JavascriptInterface
        fun info(): String {
            val bundle = try { TavernInstaller.bundleInfo(this@MainActivity) } catch (_: Exception) { null }
            return JSONObject()
                .put("app", BuildConfigCompat.versionName(this@MainActivity))
                .put("sillyTavern", bundle?.stVersion)
                .put("elephantMemory", bundle?.elephantMemory)
                .put("build", bundle?.build)
                .put("port", loadedPort)
                .put("android", Build.VERSION.RELEASE)
                .toString()
        }

        /** Status/navigation bar icon contrast for the current mood colour. */
        @JavascriptInterface
        fun setBarColor(hex: String) = ui.post {
            val color = try { Color.parseColor(hex) } catch (_: Exception) { return@post }
            val lum = (0.299 * Color.red(color) + 0.587 * Color.green(color) + 0.114 * Color.blue(color)) / 255
            val lightBars = lum > 0.6
            if (Build.VERSION.SDK_INT >= 30) {
                val mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
                window.insetsController?.setSystemBarsAppearance(if (lightBars) mask else 0, mask)
            } else {
                @Suppress("DEPRECATION")
                val flags = window.decorView.systemUiVisibility
                @Suppress("DEPRECATION")
                window.decorView.systemUiVisibility =
                    if (lightBars) flags or View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR else flags and View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR.inv()
            }
        }

        @JavascriptInterface
        fun haptic(kind: String) {
            val v = getSystemService(Vibrator::class.java) ?: return
            if (!v.hasVibrator()) return
            val effect = when (kind) {
                "tick" -> VibrationEffect.createOneShot(12, 60)
                "hit" -> VibrationEffect.createWaveform(longArrayOf(0, 40, 30, 70), intArrayOf(0, 255, 0, 180), -1)
                "heartbeat" -> VibrationEffect.createWaveform(longArrayOf(0, 30, 90, 45), intArrayOf(0, 140, 0, 200), -1)
                "rumble" -> VibrationEffect.createWaveform(longArrayOf(0, 120, 40, 160), intArrayOf(0, 90, 0, 120), -1)
                else -> VibrationEffect.createOneShot(25, 110)
            }
            v.vibrate(effect)
        }

        @JavascriptInterface
        fun keepScreenOn(on: Boolean) = ui.post {
            if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }

        @JavascriptInterface
        fun saveFile(base64: String, name: String, mime: String) {
            bg.post {
                val msg = try {
                    "Сохранено: " + saveToDownloads(Base64.decode(base64, Base64.DEFAULT), name, mime.ifBlank { "application/octet-stream" })
                } catch (e: Exception) {
                    "Не удалось сохранить: ${e.message}"
                }
                ui.post { toast(msg) }
            }
        }

        @JavascriptInterface
        fun restartServer() = ui.post { this@MainActivity.restartServer() }

        @JavascriptInterface
        fun exportBackup() = ui.post { pickBackupTarget() }

        @JavascriptInterface
        fun importBackup() = ui.post { pickBackupToImport() }

        @JavascriptInterface
        fun shareLog() = ui.post { this@MainActivity.shareLog() }

        @JavascriptInterface
        fun serverLog(): String = LogTail.read(paths.log, 24 * 1024)

        @JavascriptInterface
        fun openExternal(url: String) = ui.post { this@MainActivity.openExternal(url) }
    }
}

/** Injected after every page load: download handling for blob:/data: links. */
private const val PAGE_SHIM = """
(function(){
  if (window.__etShim) return; window.__etShim = true;
  document.documentElement.classList.add('et-app');
  function save(blob, name){
    var r = new FileReader();
    r.onload = function(){ var s = String(r.result); ElephantApp.saveFile(s.substring(s.indexOf(',')+1), name || 'download', blob.type || 'application/octet-stream'); };
    r.readAsDataURL(blob);
  }
  window.__etDownload = function(href, name){
    fetch(href, {credentials:'include'}).then(function(r){ return r.blob(); }).then(function(b){ save(b, name); })
      .catch(function(e){ console.error('[Elephant Tavern] download failed', e); });
  };
  function handles(a){ return a && a.hasAttribute && a.hasAttribute('download') && /^(blob:|data:|http:\/\/127\.0\.0\.1)/.test(a.href || ''); }
  var click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function(){
    if (handles(this)) { window.__etDownload(this.href, this.download); return; }
    return click.apply(this, arguments);
  };
  document.addEventListener('click', function(e){
    var a = e.target && e.target.closest ? e.target.closest('a[download]') : null;
    if (handles(a)) { e.preventDefault(); window.__etDownload(a.href, a.download); }
  }, true);
})();
"""
