package io.github.yhnocoder.codeboard

import android.app.ActivityManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.os.Bundle
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.google.android.material.bottomsheet.BottomSheetDialog
import io.github.yhnocoder.codeboard.core.Camera

class MainActivity : AppCompatActivity() {
    private lateinit var library: Library
    private lateinit var cache: TileCache
    private lateinit var board: BoardView
    private lateinit var bar: LinearLayout
    private lateinit var back: ImageButton
    private lateinit var title: TextView

    /** The boards under the one on screen, each with the camera it had. */
    private class Entry(val store: TileStore, val cam: Camera?)
    private val stack = ArrayList<Entry>()

    private val backCallback = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() = pop()
    }

    private fun dp(v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics)
    private fun dpi(v: Float) = dp(v).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        library = Library.load(assets)

        val am = getSystemService(ACTIVITY_SERVICE) as ActivityManager
        // tiles are hardware bitmaps (GPU memory): a share of the app's memory class, within sane bounds
        val budget = (am.memoryClass.toLong() * 1024 * 1024 / 2).coerceIn(96L shl 20, 256L shl 20)
        cache = TileCache(assets, budget) { board.tileArrived() }

        val root = FrameLayout(this)
        board = BoardView(this, cache)
        board.onOpen = { id -> open(id) }
        root.addView(board, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        bar = buildBar()
        root.addView(bar, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.TOP))
        setContentView(root)

        val barHeight = dpi(56f)
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val sys = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            bar.setPadding(sys.left + dpi(4f), sys.top, sys.right + dpi(4f), 0)
            bar.layoutParams.height = sys.top + barHeight
            bar.requestLayout()
            board.setInsets(sys.top + barHeight, sys.bottom)
            insets
        }
        onBackPressedDispatcher.addCallback(this, backCallback)

        val first = library.root
        if (first == null) {
            title.text = getString(R.string.no_boards)
            return
        }
        showBoard(cache.open(library.specs.getValue(first)), null, crossfade = false)
    }

    override fun onDestroy() {
        super.onDestroy()
        if (::board.isInitialized) board.current?.store?.let { cache.release(it) }
        for (e in stack) cache.release(e.store)
    }

    private fun showBoard(store: TileStore, cam: Camera?, crossfade: Boolean) {
        board.show(store, cam, crossfade)
        title.text = library.entry(store.spec.id)?.name ?: store.spec.name
        back.visibility = if (stack.isEmpty()) View.GONE else View.VISIBLE
        backCallback.isEnabled = stack.isNotEmpty()
    }

    /** Opens a board on top of the one on screen; one already on the back stack is returned to instead. */
    private fun open(id: String) {
        val cur = board.current ?: return
        if (cur.spec.id == id) return
        val at = stack.indexOfFirst { it.store.spec.id == id }
        if (at >= 0) {
            while (stack.size > at + 1) cache.release(stack.removeAt(stack.size - 1).store)
            pop()
            return
        }
        val spec = library.specs[id] ?: return
        stack.add(Entry(cur.store, board.camera()))
        showBoard(cache.open(spec), null, crossfade = true)
    }

    private fun pop() {
        val e = stack.removeLastOrNull() ?: return
        val leaving = board.current?.store
        showBoard(e.store, e.cam, crossfade = true)
        // released once the crossfade no longer draws it
        if (leaving != null) board.postDelayed({ cache.release(leaving) }, 1000)
    }

    // ---- top bar ----

    private fun buildBar(): LinearLayout {
        val bg = library.root?.let { library.specs[it]?.bg } ?: getColor(R.color.paper)
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            val fill = ColorDrawable((bg and 0x00ffffff) or (0xE6 shl 24))
            val line = GradientDrawable().apply { setColor(getColor(R.color.hairline)) }
            background = LayerDrawable(arrayOf(fill, line)).apply {
                setLayerGravity(1, Gravity.BOTTOM)
                setLayerHeight(1, maxOf(1, dpi(0.75f)))
            }
            elevation = 0f
            isClickable = true // touches on the bar do not reach the board

            back = icon(R.drawable.ic_back, R.string.back) { pop() }
            addView(back)
            title = TextView(context).apply {
                setTextColor(getColor(R.color.ink))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
                typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
                setPadding(dpi(12f), 0, dpi(8f), 0)
            }
            addView(title, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            addView(icon(R.drawable.ic_list, R.string.boards) { showList() })
            addView(icon(R.drawable.ic_fit, R.string.fit) { board.fit() })
        }
    }

    private fun icon(res: Int, label: Int, action: () -> Unit) = ImageButton(this).apply {
        setImageResource(res)
        contentDescription = getString(label)
        val ripple = TypedValue()
        context.theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, ripple, true)
        setBackgroundResource(ripple.resourceId)
        layoutParams = LinearLayout.LayoutParams(dpi(48f), dpi(48f))
        setOnClickListener { action() }
    }

    private fun showList() {
        val current = board.current?.spec?.id
        val sheet = BottomSheetDialog(this)
        val list = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dpi(8f), 0, dpi(24f))
        }
        list.addView(TextView(this).apply {
            text = getString(R.string.boards)
            setTextColor(getColor(R.color.secondary))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setPadding(dpi(20f), dpi(8f), dpi(20f), dpi(8f))
        })
        val ripple = TypedValue()
        theme.resolveAttribute(android.R.attr.selectableItemBackground, ripple, true)
        for ((e, depth) in library.outline()) {
            list.addView(TextView(this).apply {
                text = e.name
                setTextColor(getColor(R.color.ink))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, if (depth == 0) 17f else 15f)
                typeface = if (e.id == current) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
                minHeight = dpi(44f)
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dpi(20f + 20f * depth), 0, dpi(20f), 0)
                setBackgroundResource(ripple.resourceId)
                setOnClickListener {
                    sheet.dismiss()
                    open(e.id)
                }
            })
        }
        sheet.setContentView(ScrollView(this).apply { addView(list) })
        sheet.window?.findViewById<View>(com.google.android.material.R.id.design_bottom_sheet)
            ?.setBackgroundColor(board.current?.spec?.bg ?: getColor(R.color.paper))
        sheet.show()
    }
}
