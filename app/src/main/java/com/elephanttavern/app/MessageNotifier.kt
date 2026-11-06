package com.elephanttavern.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import android.graphics.RectF
import android.os.Build
import org.json.JSONObject
import java.io.File

/** "Ilse: Ты обещал вернуться до рассвета…" — a character writing first. */
object MessageNotifier {
    private const val CHANNEL = "messages"
    const val EXTRA_KEY = "et_open_key"
    const val EXTRA_CHAT = "et_open_chat"

    fun show(context: Context, item: JSONObject) {
        val nm = context.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "Сообщения персонажей", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Когда персонаж пишет первым"
                },
            )
        }
        val id = item.optString("id").hashCode()
        val open = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_KEY, item.optString("key"))
            .putExtra(EXTRA_CHAT, item.optString("chatFile"))
        val pi = PendingIntent.getActivity(context, id, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val name = item.optString("charName", "Персонаж")
        val text = item.optString("text")
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, CHANNEL) else Notification.Builder(context)
        builder.setSmallIcon(android.R.drawable.sym_action_chat)
            .setContentTitle(name)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_MESSAGE)
        avatar(item.optString("avatar"))?.let { builder.setLargeIcon(it) }
        nm.notify(id, builder.build())
    }

    /** The character card PNG, cropped to a circle. */
    private fun avatar(path: String): Bitmap? {
        if (path.isBlank() || !File(path).exists()) return null
        return try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(path, bounds)
            var sample = 1
            while (bounds.outWidth / sample > 384) sample *= 2
            val src = BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
            val size = minOf(src.width, src.height)
            val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
            val c = Canvas(out)
            val p = Paint(Paint.ANTI_ALIAS_FLAG)
            c.drawOval(RectF(0f, 0f, size.toFloat(), size.toFloat()), p)
            p.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)
            val top = ((src.height - size) * 0.15).toInt() // portraits: keep the face
            c.drawBitmap(src, Rect((src.width - size) / 2, top, (src.width - size) / 2 + size, top + size), Rect(0, 0, size, size), p)
            out
        } catch (_: Exception) {
            null
        }
    }
}

/** After a reboot, bring the server back if a character may write first. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        if (AppPaths(context).proactiveFlag.exists()) {
            try {
                NodeService.start(context)
            } catch (_: Exception) {
            }
        }
    }
}
