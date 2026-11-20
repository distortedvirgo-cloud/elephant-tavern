package com.elephanttavern.app

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.method.ScrollingMovementMethod
import android.util.TypedValue
import android.view.Gravity
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView

/** Boot / error screen shown while the local server starts. Pure views, no XML. */
class SplashView(context: Context) : FrameLayout(context) {

    private val dp = resources.displayMetrics.density
    private fun px(v: Int) = (v * dp).toInt()

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
        setBackgroundColor(context.getColor(R.color.bg))

        content.orientation = LinearLayout.VERTICAL
        content.gravity = Gravity.CENTER_HORIZONTAL
        content.setPadding(px(28), px(24), px(28), px(24))

        val logo = android.widget.ImageView(context).apply {
            setImageResource(R.drawable.ic_launcher_fg)
            importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        title.apply {
            text = "Elephant Tavern"
            setTextColor(Color.parseColor("#F4EFDF"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 26f)
            typeface = resources.getFont(R.font.pt_serif_bold)
            gravity = Gravity.CENTER
            letterSpacing = 0.02f
        }
        status.apply {
            setTextColor(Color.parseColor("#BEC9BC"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            gravity = Gravity.CENTER
            maxLines = 3
        }
        progress.apply {
            max = 1000
            isIndeterminate = true
            progressTintList = android.content.res.ColorStateList.valueOf(context.getColor(R.color.accent))
            indeterminateTintList = progressTintList
        }
        logView.apply {
            setTextColor(Color.parseColor("#B3BEB0"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            typeface = Typeface.MONOSPACE
            movementMethod = ScrollingMovementMethod()
            setPadding(px(12), px(10), px(12), px(10))
            background = GradientDrawable().apply {
                cornerRadius = px(14).toFloat()
                setColor(Color.parseColor("#17271F"))
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

        content.addView(logo, LinearLayout.LayoutParams(px(96), px(96)))
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
        setTextColor(Color.parseColor("#F4EFDF"))
        background = GradientDrawable().apply {
            cornerRadius = px(16).toFloat()
            if (primary) {
                setColor(Color.parseColor("#315843"))
                setStroke(px(1), context.getColor(R.color.accent))
            } else {
                setColor(Color.parseColor("#304438"))
                setStroke(px(1), Color.parseColor("#607561"))
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
}
