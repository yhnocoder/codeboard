package io.github.yhnocoder.codeboard

import android.app.ActivityManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import io.github.yhnocoder.codeboard.core.BoardRepo
import io.github.yhnocoder.codeboard.core.Camera
import io.github.yhnocoder.codeboard.core.Cancelled
import io.github.yhnocoder.codeboard.core.GitHub
import io.github.yhnocoder.codeboard.core.Remote
import io.github.yhnocoder.codeboard.core.RemoteIndex
import io.github.yhnocoder.codeboard.core.StaleIndex
import java.util.Locale
import java.util.concurrent.Executors
import java.util.zip.ZipFile

class MainActivity : AppCompatActivity() {
    private lateinit var settings: Settings
    private lateinit var cache: TileCache
    private lateinit var board: BoardView
    private lateinit var bar: LinearLayout
    private lateinit var back: ImageButton
    private lateinit var title: TextView
    private lateinit var statusCard: LinearLayout
    private lateinit var statusText: TextView
    private lateinit var statusProgress: ProgressBar

    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newCachedThreadPool()

    private var repo: BoardRepo? = null
    private var branch: String? = null
    private var index: RemoteIndex? = null

    /** Bumped when the repository or branch changes: answers for the old one are dropped. */
    @Volatile private var gen = 0

    /** Bumped by every board opened (and by back): a board still downloading is dropped when another is asked for. */
    @Volatile private var opening = 0
    private var downloadingAll = false

    /** The board being downloaded or opened, if any. */
    private var pendingId: String? = null

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
        settings = Settings(this)

        val am = getSystemService(ACTIVITY_SERVICE) as ActivityManager
        // tiles are hardware bitmaps (GPU memory): a share of the app's memory class, within sane bounds
        val budget = (am.memoryClass.toLong() * 1024 * 1024 / 2).coerceIn(96L shl 20, 256L shl 20)
        cache = TileCache(budget) { board.tileArrived() }

        val root = FrameLayout(this)
        board = BoardView(this, cache)
        board.id = R.id.board
        board.onOpen = { id -> open(id) }
        root.addView(board, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        bar = buildBar()
        root.addView(bar, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.TOP))
        statusCard = buildStatus()
        val statusParams = FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.BOTTOM)
        root.addView(statusCard, statusParams)
        setContentView(root)

        val barHeight = dpi(56f)
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val sys = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            bar.setPadding(sys.left + dpi(4f), sys.top, sys.right + dpi(4f), 0)
            bar.layoutParams.height = sys.top + barHeight
            bar.requestLayout()
            statusParams.setMargins(sys.left + dpi(16f), 0, sys.right + dpi(16f), sys.bottom + dpi(16f))
            statusCard.layoutParams = statusParams
            board.setInsets(sys.top + barHeight, sys.bottom)
            insets
        }
        onBackPressedDispatcher.addCallback(this, backCallback)
        title.text = getString(R.string.app_name)

        if (settings.token.isNullOrEmpty() || settings.repo == null) showSettings(first = true) else start()
    }

    override fun onDestroy() {
        super.onDestroy()
        gen++
        releaseAll()
        io.shutdownNow()
    }

    // ---- repository and branch ----

    /** (Re)connects to the repository in the settings: its last branch, or the default one. */
    private fun start() {
        val token = settings.token ?: return
        val name = settings.repo ?: return
        val g = ++gen
        releaseAll()
        index = null
        branch = null
        val gh = GitHub(token)
        repo = BoardRepo(BoardRepo.folder(filesDir, name), name, gh)
        val last = settings.branch(name)
        if (last != null) {
            setBranch(last)
            return
        }
        status(Kind.LOADING, "Connecting to $name…", indeterminate = true)
        io.execute {
            try {
                val info = gh.repo(name)
                main.post { if (g == gen) setBranch(info.defaultBranch) }
            } catch (e: Exception) {
                main.post { if (g == gen) status(Kind.MESSAGE, Settings.explain(e, name) + "\nTap to retry.") { start() } }
            }
        }
    }

    /** Shows a branch: its saved index at once, then whatever the release has now. */
    private fun setBranch(b: String) {
        val r = repo ?: return
        val g = ++gen
        settings.setBranch(r.repo, b)
        branch = b
        releaseAll()
        index = r.cachedIndex(b)
        if (index != null) {
            hideStatus(Kind.LOADING)
            openRoot()
        } else {
            status(Kind.LOADING, "Loading $b…", indeterminate = true)
        }
        refresh(g)
    }

    private fun refresh(g: Int) {
        val r = repo ?: return
        val b = branch ?: return
        io.execute {
            val res = try {
                r.refresh(b)
            } catch (e: Exception) {
                main.post {
                    if (g != gen) return@post
                    if (index == null) {
                        status(Kind.MESSAGE, Settings.explain(e, r.repo) + "\nTap to retry.") { setBranch(b) }
                    } else {
                        toast("Offline: showing the saved copy of $b")
                    }
                }
                return@execute
            }
            main.post {
                if (g != gen) return@post
                when (res) {
                    is BoardRepo.Refresh.Updated -> {
                        // the board on screen stays; boards with a new hash download when opened
                        val first = index == null
                        index = res.index
                        hideStatus(Kind.LOADING)
                        if (first || board.current == null && pendingId == null) openRoot()
                    }
                    BoardRepo.Refresh.Unchanged -> hideStatus(Kind.LOADING)
                    BoardRepo.Refresh.NoRelease -> {
                        index = null
                        releaseAll()
                        title.text = b
                        status(Kind.MESSAGE, "No phone data for this branch yet (it is built after a push).")
                    }
                }
            }
        }
    }

    // ---- boards ----

    private fun openRoot() {
        val id = index?.root ?: return
        openBoard(id, push = false)
    }

    /** Opens a board on top of the one on screen; one already on the back stack is returned to instead. */
    private fun open(id: String) {
        val cur = board.current
        if (cur?.spec?.id == id) return
        val at = stack.indexOfFirst { it.store.spec.id == id }
        if (at >= 0) {
            while (stack.size > at + 1) cache.release(stack.removeAt(stack.size - 1).store)
            pop()
            return
        }
        openBoard(id, push = true)
    }

    /** Downloads the board's zip when it is not cached (with progress), opens it and shows it. */
    private fun openBoard(id: String, push: Boolean) {
        val r = repo ?: return
        val b = branch ?: return
        val entry = index?.board(id) ?: return
        val token = ++opening
        val g = gen
        pendingId = id
        if (r.zip(entry) == null) {
            status(Kind.DOWNLOAD, "Downloading “${entry.name}” (${mb(entry.size)})", fraction = 0f)
        }
        io.execute {
            try {
                val file = r.download(
                    b, entry,
                    progress = { done, total ->
                        main.post {
                            if (token == opening && g == gen) {
                                status(Kind.DOWNLOAD, "Downloading “${entry.name}” (${mb(done)} of ${mb(total)})", fraction = frac(done, total))
                            }
                        }
                    },
                    cancelled = { token != opening || g != gen },
                )
                val zip = ZipFile(file)
                val spec = try {
                    val m = zip.getEntry("manifest.json") ?: error("the zip has no manifest.json")
                    Remote.manifest(zip.getInputStream(m).use { it.readBytes().toString(Charsets.UTF_8) })
                } catch (e: Exception) {
                    zip.close()
                    throw e
                }
                main.post {
                    if (token != opening || g != gen) {
                        zip.close()
                        return@post
                    }
                    pendingId = null
                    hideStatus(Kind.DOWNLOAD)
                    val store = cache.open(spec, zip)
                    val cur = board.current
                    if (cur != null) {
                        if (push) stack.add(Entry(cur.store, board.camera())) else releaseLater(cur.store)
                    }
                    showBoard(store, entry.name, null, crossfade = cur != null)
                }
            } catch (e: Cancelled) {
            } catch (e: Exception) {
                main.post {
                    if (token == opening && g == gen) {
                        pendingId = null
                        if (e is StaleIndex) refresh(g)
                        status(Kind.MESSAGE, "Couldn't open “${entry.name}”. " + Settings.explain(e, r.repo) + "\nTap to dismiss.") {
                            hideStatus(Kind.MESSAGE)
                        }
                    }
                }
            }
        }
    }

    private fun showBoard(store: TileStore, name: String?, cam: Camera?, crossfade: Boolean) {
        board.show(store, cam, crossfade)
        title.text = name ?: index?.board(store.spec.id)?.name ?: store.spec.name
        back.visibility = if (stack.isEmpty()) View.GONE else View.VISIBLE
        backCallback.isEnabled = stack.isNotEmpty()
    }

    private fun pop() {
        val e = stack.removeLastOrNull() ?: return
        opening++
        pendingId = null
        hideStatus(Kind.DOWNLOAD)
        val leaving = board.current?.store
        showBoard(e.store, null, e.cam, crossfade = true)
        if (leaving != null) releaseLater(leaving)
    }

    /** Released once the crossfade no longer draws it. */
    private fun releaseLater(s: TileStore) {
        board.postDelayed({ cache.release(s) }, 1000)
    }

    private fun releaseAll() {
        opening++
        pendingId = null
        // whatever the card said was about what is going away
        kind = Kind.NONE
        statusCard.visibility = View.GONE
        val cur = board.current
        board.clear()
        cur?.let { cache.release(it.store) }
        for (e in stack) cache.release(e.store)
        stack.clear()
        back.visibility = View.GONE
        backCallback.isEnabled = false
        title.text = getString(R.string.app_name)
    }

    private fun downloadAll() {
        val r = repo ?: return
        val b = branch ?: return
        val idx = index ?: return
        if (downloadingAll) return
        val missing = Remote.missing(idx, r.presentZips())
        if (missing.isEmpty()) {
            toast("All boards are downloaded")
            return
        }
        downloadingAll = true
        val g = gen
        val total = missing.sumOf { it.size }
        status(Kind.ALL, "Downloading ${missing.size} boards (${mb(total)})", fraction = 0f)
        io.execute {
            var failed: Exception? = null
            var before = 0L
            for ((k, e) in missing.withIndex()) {
                if (g != gen) break
                try {
                    val base = before
                    r.download(b, e, progress = { done, _ ->
                        val f = frac(base + done, total)
                        main.post {
                            if (g == gen) status(Kind.ALL, "Downloading boards: ${k + 1} of ${missing.size}", fraction = f)
                        }
                    }, cancelled = { g != gen })
                } catch (c: Cancelled) {
                    break
                } catch (x: Exception) {
                    failed = x
                    break
                }
                before += e.size
            }
            main.post {
                downloadingAll = false
                if (g != gen) return@post
                val f = failed
                if (f != null) {
                    status(Kind.MESSAGE, "Download stopped. " + Settings.explain(f, r.repo) + "\nTap to dismiss.") { hideStatus(Kind.MESSAGE) }
                } else {
                    hideStatus(Kind.ALL)
                    toast("All boards downloaded")
                }
            }
        }
    }

    // ---- status card ----

    private enum class Kind { NONE, LOADING, MESSAGE, ALL, DOWNLOAD }

    private var kind = Kind.NONE

    /** Shows a message at the bottom; a board download wins over the "download all" progress. */
    private fun status(k: Kind, text: String, fraction: Float? = null, indeterminate: Boolean = false, onTap: (() -> Unit)? = null) {
        if (k == Kind.ALL && kind == Kind.DOWNLOAD) return
        kind = k
        statusText.text = text
        statusProgress.visibility = if (fraction != null || indeterminate) View.VISIBLE else View.GONE
        statusProgress.isIndeterminate = indeterminate
        if (fraction != null) statusProgress.progress = (fraction * 1000).toInt()
        statusCard.visibility = View.VISIBLE
        if (onTap != null) statusCard.setOnClickListener { onTap() } else {
            statusCard.setOnClickListener(null)
            statusCard.isClickable = false
        }
    }

    private fun hideStatus(k: Kind) {
        if (kind != k) return
        kind = Kind.NONE
        statusCard.visibility = View.GONE
    }

    private fun buildStatus() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = GradientDrawable().apply {
            setColor(getColor(R.color.paper))
            cornerRadius = dp(14f)
            setStroke(maxOf(1, dpi(0.75f)), getColor(R.color.hairline))
        }
        elevation = dp(6f)
        setPadding(dpi(16f), dpi(12f), dpi(16f), dpi(12f))
        visibility = View.GONE
        statusText = TextView(context).apply {
            setTextColor(getColor(R.color.ink))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        }
        addView(statusText)
        statusProgress = ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 1000
            progressTintList = ColorStateList.valueOf(getColor(R.color.ink))
            indeterminateTintList = ColorStateList.valueOf(getColor(R.color.ink))
        }
        addView(statusProgress, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dpi(8f) })
    }

    // ---- top bar ----

    private fun buildBar(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        val fill = ColorDrawable((getColor(R.color.paper) and 0x00ffffff) or (0xE6 shl 24))
        val line = GradientDrawable().apply { setColor(getColor(R.color.hairline)) }
        background = LayerDrawable(arrayOf(fill, line)).apply {
            setLayerGravity(1, Gravity.BOTTOM)
            setLayerHeight(1, maxOf(1, dpi(0.75f)))
        }
        isClickable = true // touches on the bar do not reach the board

        back = icon(R.drawable.ic_back, R.string.back) { pop() }
        back.visibility = View.GONE
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

    private fun icon(res: Int, label: Int, action: () -> Unit) = ImageButton(this).apply {
        setImageResource(res)
        contentDescription = getString(label)
        val ripple = TypedValue()
        context.theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, ripple, true)
        setBackgroundResource(ripple.resourceId)
        layoutParams = LinearLayout.LayoutParams(dpi(48f), dpi(48f))
        setOnClickListener { action() }
    }

    // ---- board list sheet ----

    private fun text(s: String, sp: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
        text = s
        setTextColor(getColor(color))
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
        if (bold) typeface = Typeface.DEFAULT_BOLD
    }

    private fun ripple(v: View) {
        val t = TypedValue()
        theme.resolveAttribute(android.R.attr.selectableItemBackground, t, true)
        v.setBackgroundResource(t.resourceId)
    }

    private fun showList() {
        val sheet = BottomSheetDialog(this)
        val list = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dpi(8f), 0, dpi(24f))
        }
        val idx = index
        val r = repo

        // header: the branch (tap to switch), its commit and when it was built
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dpi(20f), dpi(8f), dpi(20f), dpi(10f))
            ripple(this)
        }
        header.addView(text(r?.repo ?: settings.repo.orEmpty(), 12f, R.color.secondary))
        header.addView(text("${branch ?: "No branch"}  ▾", 19f, R.color.ink, bold = true).apply { setPadding(0, dpi(2f), 0, dpi(2f)) })
        val sub = text(
            if (idx == null) "No phone data loaded" else
                "${idx.commit.take(7)} · built ${Remote.ago(idx.built)} · ${idx.boards.size} boards",
            13f, R.color.secondary,
        )
        header.addView(sub)
        header.setOnClickListener { pickBranch(sheet, sub) }
        list.addView(header)

        // actions
        val actions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dpi(8f), 0, dpi(8f), dpi(4f))
        }
        fun action(label: String, f: () -> Unit) = text(label, 14f, R.color.ink).apply {
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            setPadding(dpi(12f), dpi(10f), dpi(12f), dpi(10f))
            ripple(this)
            setOnClickListener { sheet.dismiss(); f() }
        }
        val present = r?.presentZips() ?: emptySet()
        if (idx != null && r != null) {
            val missing = Remote.missing(idx, present)
            if (missing.isNotEmpty()) actions.addView(action("Download all (${mb(missing.sumOf { it.size })})") { downloadAll() })
            actions.addView(action("Refresh") { refresh(gen) })
        }
        actions.addView(action("Settings") { showSettings(first = false) })
        list.addView(actions)
        list.addView(View(this).apply { setBackgroundColor(getColor(R.color.hairline)) }, LinearLayout.LayoutParams(MATCH_PARENT, maxOf(1, dpi(0.75f))))

        val current = board.current?.spec?.id
        if (idx != null) for ((e, depth) in idx.outline()) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                minimumHeight = dpi(44f)
                setPadding(dpi(20f + 20f * depth), 0, dpi(20f), 0)
                ripple(this)
                setOnClickListener {
                    sheet.dismiss()
                    open(e.id)
                }
            }
            row.addView(text(e.name, if (depth == 0) 17f else 15f, R.color.ink, bold = e.id == current).apply {
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
            }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            if (e.asset !in present) row.addView(text("↓ ${mb(e.size)}", 12f, R.color.secondary).apply { setPadding(dpi(8f), 0, 0, 0) })
            list.addView(row)
        }
        sheet.setContentView(ScrollView(this).apply { addView(list) })
        sheet.window?.findViewById<View>(com.google.android.material.R.id.design_bottom_sheet)
            ?.setBackgroundColor(board.current?.spec?.bg ?: getColor(R.color.paper))
        sheet.show()
    }

    private fun pickBranch(sheet: BottomSheetDialog, sub: TextView) {
        val r = repo ?: return
        val keep = sub.text
        sub.text = "Loading branches…"
        io.execute {
            try {
                val names = r.gh.branches(r.repo)
                main.post {
                    sub.text = keep
                    if (isFinishing) return@post
                    val checked = names.indexOf(branch)
                    var dialog: AlertDialog? = null
                    dialog = MaterialAlertDialogBuilder(this)
                        .setTitle("Branch")
                        .setSingleChoiceItems(names.toTypedArray(), checked) { _, which ->
                            dialog?.dismiss()
                            sheet.dismiss()
                            if (names[which] != branch) setBranch(names[which])
                        }
                        .setNegativeButton("Cancel", null)
                        .show()
                }
            } catch (e: Exception) {
                main.post {
                    sub.text = keep
                    toast(Settings.explain(e, r.repo))
                }
            }
        }
    }

    // ---- settings ----

    private fun showSettings(first: Boolean) {
        val pad = dpi(24f)
        val form = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, dpi(8f), pad, 0)
        }
        form.addView(text("Repository (owner/name)", 13f, R.color.secondary))
        val repoField = EditText(this).apply {
            setText(settings.repo.orEmpty())
            hint = "owner/name"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or InputType.TYPE_TEXT_VARIATION_URI
            isSingleLine = true
        }
        form.addView(repoField)
        form.addView(text("GitHub token", 13f, R.color.secondary).apply { setPadding(0, dpi(12f), 0, 0) })
        val hasToken = !settings.token.isNullOrEmpty()
        val tokenField = EditText(this).apply {
            hint = if (hasToken) "Saved (leave empty to keep it)" else "github_pat_…"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            isSingleLine = true
        }
        form.addView(tokenField)
        form.addView(text("A fine-grained token with read-only access to Contents of this repository.", 13f, R.color.secondary))
        val error = text("", 14f, R.color.error).apply { setPadding(0, dpi(12f), 0, 0) }
        form.addView(error)

        val dialog = MaterialAlertDialogBuilder(this)
            .setTitle(if (first) "Connect to GitHub" else "Settings")
            .setView(form)
            .setPositiveButton("Connect", null)
            .apply { if (!first) setNegativeButton("Cancel", null) }
            .setCancelable(!first)
            .create()
        dialog.setOnShowListener {
            val ok = dialog.getButton(AlertDialog.BUTTON_POSITIVE)
            ok.setOnClickListener {
                val name = repoField.text.toString().trim().removePrefix("https://github.com/").trimEnd('/')
                val token = tokenField.text.toString().trim().ifEmpty { settings.token.orEmpty() }
                if (!Settings.validRepo(name)) {
                    error.text = "Write the repository as owner/name."
                    return@setOnClickListener
                }
                if (token.isEmpty()) {
                    error.text = "Paste a token."
                    return@setOnClickListener
                }
                ok.isEnabled = false
                error.setTextColor(getColor(R.color.secondary))
                error.text = "Checking…"
                io.execute {
                    try {
                        val info = GitHub(token).repo(name)
                        main.post {
                            settings.repo = name
                            settings.token = token
                            if (settings.branch(name) == null) settings.setBranch(name, info.defaultBranch)
                            dialog.dismiss()
                            start()
                        }
                    } catch (e: Exception) {
                        main.post {
                            ok.isEnabled = true
                            error.setTextColor(getColor(R.color.error))
                            error.text = Settings.explain(e, name)
                        }
                    }
                }
            }
        }
        dialog.show()
    }

    // ---- small things ----

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()

    private fun frac(done: Long, total: Long) = if (total <= 0) 0f else (done.toFloat() / total).coerceIn(0f, 1f)

    private fun mb(bytes: Long) = if (bytes < 1024 * 1024) "${(bytes + 1023) / 1024} KB" else String.format(Locale.US, "%.1f MB", bytes / 1048576.0)
}
