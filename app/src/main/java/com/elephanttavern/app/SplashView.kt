package com.elephanttavern.app

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.method.ScrollingMovementMethod
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.animation.LinearInterpolator
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import kotlin.math.sin

/** Boot / error screen shown while the local server starts. Pure views, no XML. */
class SplashView(context: Context) : FrameLayout(context) {

    private val dp = resources.displayMetrics.density
    private fun px(v: Int) = (v * dp).toInt()

    private val aurora = AuroraView(context)
    private val title = TextView(context)
    private val status = TextView(context)
    private val progress = ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal)
    private val logView = TextView(context)
    private val buttons = LinearLayout(context)
    private val content = LinearLayout(context)

    var onRestart: (() -> Unit)? = null
    var onShareLog: (() -> Unit)? = null
    var onImportBackup: (() -> Unit)? = null

    init {
        setBackgroundColor(Color.parseColor("#0D0F14"))
        addView(aurora, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))

        content.orientation = LinearLayout.VERTICAL
        content.gravity = Gravity.CENTER_HORIZONTAL
        content.setPadding(px(28), px(24), px(28), px(24))

        val logo = TextView(context).apply {
            text = "🐘"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 64f)
            gravity = Gravity.CENTER
        }
        title.apply {
            text = "Elephant Tavern"
            setTextColor(Color.parseColor("#EDE7FF"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 26f)
            typeface = Typeface.create("serif", Typeface.BOLD)
            gravity = Gravity.CENTER
            letterSpacing = 0.02f
        }
        status.apply {
            setTextColor(Color.parseColor("#A99BC9"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            gravity = Gravity.CENTER
            maxLines = 3
        }
        progress.apply {
            max = 1000
            isIndeterminate = true
            progressTintList = android.content.res.ColorStateList.valueOf(Color.parseColor("#B48CFF"))
            indeterminateTintList = progressTintList
        }
        logView.apply {
            setTextColor(Color.parseColor("#8A84A0"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            typeface = Typeface.MONOSPACE
            movementMethod = ScrollingMovementMethod()
            setPadding(px(12), px(10), px(12), px(10))
            background = GradientDrawable().apply {
                cornerRadius = px(14).toFloat()
                setColor(Color.parseColor("#AA0A0B10"))
                setStroke(px(1), Color.parseColor("#22FFFFFF"))
            }
            visibility = GONE
        }
        buttons.apply {
            orientation = LinearLayout.VERTICAL
            visibility = GONE
            addView(button("Перезапустить сервер", primary = true) { onRestart?.invoke() })
            addView(button("Поделиться логом") { onShareLog?.invoke() })
            addView(button("Восстановить из бэкапа") { onImportBackup?.invoke() })
        }

        content.addView(logo, LinearLayout.LayoutParams(-2, -2))
        content.addView(title, LinearLayout.LayoutParams(-2, -2).apply { topMargin = px(6) })
        content.addView(status, LinearLayout.LayoutParams(-1, -2).apply { topMargin = px(18) })
        content.addView(progress, LinearLayout.LayoutParams(px(220), px(6)).apply { topMargin = px(16) })
        content.addView(logView, LinearLayout.LayoutParams(-1, 0, 1f).apply { topMargin = px(20) })
        content.addView(buttons, LinearLayout.LayoutParams(-1, -2).apply { topMargin = px(14) })
        addView(content, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT).apply {
            gravity = Gravity.CENTER
        })
        showBooting("Подготовка…", null)
    }

    private fun button(label: String, primary: Boolean = false, onClick: () -> Unit) = Button(context).apply {
        text = label
        isAllCaps = false
        setTextColor(if (primary) Color.parseColor("#15121F") else Color.parseColor("#E4DAFF"))
        background = GradientDrawable().apply {
            cornerRadius = px(16).toFloat()
            if (primary) setColor(Color.parseColor("#B48CFF")) else {
                setColor(Color.parseColor("#1C1A26"))
                setStroke(px(1), Color.parseColor("#33B48CFF"))
            }
        }
        layoutParams = LinearLayout.LayoutParams(-1, px(50)).apply { topMargin = px(8) }
        setOnClickListener { onClick() }
    }

    fun showBooting(message: String, fraction: Float?) {
        status.text = message
        if (fraction == null || fraction <= 0f) {
            progress.isIndeterminate = true
        } else {
            progress.isIndeterminate = false
            progress.progress = (fraction * 1000).toInt()
        }
        progress.visibility = VISIBLE
        logView.visibility = GONE
        buttons.visibility = GONE
        content.gravity = Gravity.CENTER
        (logView.layoutParams as LinearLayout.LayoutParams).height = 0
        (logView.layoutParams as LinearLayout.LayoutParams).weight = 0f
    }

    fun showError(message: String, log: String) {
        status.text = message
        progress.visibility = GONE
        logView.visibility = VISIBLE
        logView.text = log.ifBlank { "(лог пуст)" }
        (logView.layoutParams as LinearLayout.LayoutParams).weight = 1f
        logView.post { logView.scrollTo(0, (logView.layout?.height ?: 0) - logView.height + px(20)) }
        buttons.visibility = VISIBLE
        content.gravity = Gravity.CENTER_HORIZONTAL
        requestLayout()
    }

    fun setInsets(top: Int, bottom: Int) {
        content.setPadding(px(28), px(24) + top, px(28), px(24) + bottom)
    }

    /** Slow drifting aurora behind the logo. */
    private class AuroraView(context: Context) : View(context) {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        private var t = 0f
        private val anim = ValueAnimator.ofFloat(0f, 1000f).apply {
            duration = 1_000_000
            interpolator = LinearInterpolator()
            repeatCount = ValueAnimator.INFINITE
            addUpdateListener { t = it.animatedValue as Float; invalidate() }
        }

        override fun onAttachedToWindow() {
            super.onAttachedToWindow(); anim.start()
        }

        override fun onDetachedFromWindow() {
            anim.cancel(); super.onDetachedFromWindow()
        }

        override fun onDraw(canvas: Canvas) {
            val w = width.toFloat()
            val h = height.toFloat()
            paint.shader = LinearGradient(0f, 0f, 0f, h, Color.parseColor("#0D0F14"), Color.parseColor("#120E1C"), Shader.TileMode.CLAMP)
            canvas.drawRect(0f, 0f, w, h, paint)
            blob(canvas, w * (0.3f + 0.1f * sin(t * 0.4f)), h * 0.32f, w * 0.7f, Color.parseColor("#40B48CFF"))
            blob(canvas, w * (0.75f + 0.08f * sin(t * 0.3f + 2f)), h * (0.55f + 0.05f * sin(t * 0.2f)), w * 0.6f, Color.parseColor("#3045C6FF"))
            blob(canvas, w * 0.5f, h * (0.85f + 0.04f * sin(t * 0.5f + 1f)), w * 0.8f, Color.parseColor("#28FF7AB6"))
        }

        private fun blob(canvas: Canvas, x: Float, y: Float, r: Float, color: Int) {
            paint.shader = RadialGradient(x, y, r, color, Color.TRANSPARENT, Shader.TileMode.CLAMP)
            canvas.drawCircle(x, y, r, paint)
        }
    }
}
