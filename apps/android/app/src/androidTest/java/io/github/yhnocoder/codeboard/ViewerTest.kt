package io.github.yhnocoder.codeboard

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Build
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import android.view.View
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.GeneralClickAction
import androidx.test.espresso.action.GeneralSwipeAction
import androidx.test.espresso.action.Press
import androidx.test.espresso.action.Swipe
import androidx.test.espresso.action.Tap
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.test.espresso.matcher.RootMatchers.isDialog
import androidx.test.espresso.matcher.ViewMatchers.isDisplayed
import androidx.test.espresso.matcher.ViewMatchers.withContentDescription
import androidx.test.espresso.matcher.ViewMatchers.withId
import androidx.test.espresso.matcher.ViewMatchers.withText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.yhnocoder.codeboard.core.FakeGitHub
import io.github.yhnocoder.codeboard.core.GitHub
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlin.math.abs

/**
 * The app against a fake GitHub (FakeGitHub: the API and the storage host its downloads redirect to) whose releases hold small
 * boards made here: real WebP tiles of flat colours, so what the board view draws can be read back off the screen.
 */
@RunWith(AndroidJUnit4::class)
class ViewerTest {
    private lateinit var fake: FakeGitHub
    private lateinit var scenario: ActivityScenario<MainActivity>
    private val context: Context = ApplicationProvider.getApplicationContext()

    @Before
    fun setUp() {
        context.getSharedPreferences("settings", Context.MODE_PRIVATE).edit().clear().commit()
        context.getSharedPreferences("secret-plain", Context.MODE_PRIVATE).edit().clear().commit()
        File(context.filesDir, "repos").deleteRecursively()
        fake = FakeGitHub()
        fake.branches = listOf("main", "dev")
        fake.releases["mobile-main"] = release(
            Board("root", "Main root", ROOT, subs = listOf("sub"), hit = SUB_HIT to "sub"),
            Board("sub", "Main sub", SUB),
        )
        fake.releases["mobile-dev"] = release(Board("devroot", "Dev root", DEV))
        GitHub.endpoint = fake.apiUrl
        Settings(context).apply {
            repo = "o/r"
            token = "secret-token"
        }
        scenario = ActivityScenario.launch(MainActivity::class.java)
    }

    @After
    fun tearDown() {
        scenario.close()
        fake.close()
    }

    @Test
    fun boardListLoads() {
        shown("root", "Main root")
        onView(withContentDescription(R.string.boards)).perform(click())
        eventually { onView(withText("Main sub")).inRoot(isDialog()).check(matches(isDisplayed())) }
        onView(withText("main  ▾")).inRoot(isDialog()).check(matches(isDisplayed()))
        onView(withText("Main root")).inRoot(isDialog()).check(matches(isDisplayed()))
    }

    @Test
    fun switchesBranch() {
        shown("root", "Main root")
        onView(withContentDescription(R.string.boards)).perform(click())
        eventually { onView(withText("main  ▾")).inRoot(isDialog()).perform(click()) }
        eventually { onView(withText("dev")).inRoot(isDialog()).perform(click()) }
        shown("devroot", "Dev root")
        assertEquals("dev", Settings(context).branch("o/r"))
        assertColor(DEV, pointOf(100.0, 100.0))
    }

    @Test
    fun opensAndDrawsTheBoard() {
        shown("root", "Main root")
        assertColor(ROOT, pointOf(100.0, 100.0))
        assertColor(SUB, pointOf(SUB_HIT[0] + 20.0, SUB_HIT[1] + 20.0))
    }

    @Test
    fun pinchAndPanMoveTheView() {
        shown("root", "Main root")
        val fitted = camera()
        pinch(from = 60f, to = 360f)
        val zoomed = until("the pinch zooms in") { camera().takeIf { it[2] > fitted[2] * 1.5 } }
        onView(withId(R.id.board)).perform(GeneralSwipeAction(Swipe.SLOW, { centre(it, 0.3f, 0f) }, { centre(it, -0.3f, 0f) }, Press.FINGER))
        until("the pan moves the board left") { camera().takeIf { it[0] < zoomed[0] - 50 } }
    }

    @Test
    fun tapOnSubBoardOpensIt() {
        shown("root", "Main root")
        val (x, y) = pointOf(SUB_HIT[0] + SUB_HIT[2] / 2, SUB_HIT[1] + SUB_HIT[3] / 2)
        onView(withId(R.id.board)).perform(
            GeneralClickAction(Tap.SINGLE, { v -> onScreen(v, x, y) }, Press.FINGER, InputDevice.SOURCE_TOUCHSCREEN, MotionEvent.BUTTON_PRIMARY),
        )
        shown("sub", "Main sub")
        eventually { onView(withContentDescription(R.string.back)).check(matches(isDisplayed())) }
        assertColor(SUB, pointOf(100.0, 100.0))
    }

    // ---- the app's state ----

    private fun <T : Any> until(what: String, timeoutMs: Long = 15_000, f: (MainActivity) -> T?): T {
        val end = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            var got: T? = null
            scenario.onActivity { got = f(it) }
            got?.let { if (it != false) return it }
            if (SystemClock.uptimeMillis() > end) throw AssertionError("timed out waiting for $what")
            SystemClock.sleep(50)
        }
    }

    private fun board(a: MainActivity) = a.findViewById<BoardView>(R.id.board)

    /** Waits for a board to be on screen under its title, with its coarsest tiles decoded */
    private fun shown(id: String, title: String) {
        until("board $id shown") { a ->
            val s = board(a).current
            val titled = ArrayList<View>().also { a.window.decorView.findViewsWithText(it, title, View.FIND_VIEWS_WITH_TEXT) }
            s != null && s.spec.id == id && s.store.coarseReady() && titled.isNotEmpty()
        }
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
    }

    /** Retries an Espresso step until it passes: what it looks for arrives from a background thread */
    private fun eventually(timeoutMs: Long = 15_000, step: () -> Unit) {
        val end = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            try {
                return step()
            } catch (e: Throwable) {
                if (SystemClock.uptimeMillis() > end) throw e
                SystemClock.sleep(100)
            }
        }
    }

    /** tx, ty, zoom */
    private fun camera(): DoubleArray = until("a camera") { a -> board(a).camera()?.let { doubleArrayOf(it.tx, it.ty, it.zoom) } }

    /** Where a world point of the board on screen is, in the board view's px */
    private fun pointOf(wx: Double, wy: Double): Pair<Float, Float> {
        val c = camera()
        return (wx * c[2] + c[0]).toFloat() to (wy * c[2] + c[1]).toFloat()
    }

    private fun onScreen(v: View, x: Float, y: Float): FloatArray {
        val at = IntArray(2)
        v.getLocationOnScreen(at)
        return floatArrayOf(at[0] + x, at[1] + y)
    }

    private fun centre(v: View, dx: Float, dy: Float) = onScreen(v, v.width * (0.5f + dx), v.height * (0.5f + dy))

    // ---- the screen ----

    private fun assertColor(want: Int, at: Pair<Float, Float>) {
        val origin = IntArray(2)
        scenario.onActivity { board(it).getLocationOnScreen(origin) }
        val x = (origin[0] + at.first).toInt()
        val y = (origin[1] + at.second).toInt()
        val got = until("a screenshot showing ${Integer.toHexString(want)} at $x,$y", 5_000) {
            val shot = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot() ?: return@until null
            val px = shot.getPixel(x, y)
            shot.recycle()
            px.takeIf { close(it, want) }
        }
        assertTrue(close(got, want))
    }

    private fun close(a: Int, b: Int) =
        abs(Color.red(a) - Color.red(b)) <= 8 && abs(Color.green(a) - Color.green(b)) <= 8 && abs(Color.blue(a) - Color.blue(b)) <= 8

    /** Two fingers from `from` px apart to `to` px apart, about the board's centre */
    private fun pinch(from: Float, to: Float) {
        val ui = InstrumentationRegistry.getInstrumentation().uiAutomation
        var c = floatArrayOf(0f, 0f)
        scenario.onActivity { c = centre(board(it), 0f, 0f) }
        val down = SystemClock.uptimeMillis()
        val props = Array(2) { MotionEvent.PointerProperties().apply { id = it; toolType = MotionEvent.TOOL_TYPE_FINGER } }
        fun coords(d: Float) = Array(2) { i ->
            MotionEvent.PointerCoords().apply {
                x = c[0] + (if (i == 0) -d else d) / 2
                y = c[1]
                pressure = 1f
                size = 1f
            }
        }
        fun send(action: Int, n: Int, d: Float, t: Long) {
            val e = MotionEvent.obtain(down, t, action, n, props, coords(d), 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0)
            ui.injectInputEvent(e, true)
            e.recycle()
        }
        var t = down
        send(MotionEvent.ACTION_DOWN, 1, from, t)
        send(MotionEvent.ACTION_POINTER_DOWN or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT), 2, from, t)
        val steps = 20
        for (i in 1..steps) {
            t += 16
            send(MotionEvent.ACTION_MOVE, 2, from + (to - from) * i / steps, t)
        }
        t += 16
        send(MotionEvent.ACTION_POINTER_UP or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT), 2, to, t)
        send(MotionEvent.ACTION_UP, 1, to, t)
    }

    // ---- the fake boards ----

    private class Board(val id: String, val name: String, val colour: Int, val subs: List<String> = emptyList(), val hit: Pair<DoubleArray, String>? = null)

    private fun release(vararg boards: Board): MutableMap<String, ByteArray> {
        val out = HashMap<String, ByteArray>()
        val entries = boards.mapIndexed { i, b ->
            val hash = "%016x".format(i + 1L)
            val zip = zip(b)
            out["${b.id}-$hash.zip"] = zip
            val subs = b.subs.joinToString(",", "[", "]") { "\"$it\"" }
            """{"id":"${b.id}","name":"${b.name}","cards":2,"subs":$subs,"hash":"$hash","asset":"${b.id}-$hash.zip","size":${zip.size}}"""
        }
        out["index.json"] =
            """{"branch":"b","commit":"0123456789abcdef","codeboard":"c0ffee","built":"2026-11-08T10:00:00Z","boards":${entries.joinToString(",", "[", "]")}}"""
                .toByteArray()
        return out
    }

    /** A board's zip as the tile builder writes it: a manifest and the tiles of two levels, stored */
    private fun zip(b: Board): ByteArray {
        val levels = listOf(1.0 to (4 to 4), 0.5 to (2 to 2))
        val hits = b.hit?.let { (r, id) -> """[{"rect":{"x":${r[0]},"y":${r[1]},"w":${r[2]},"h":${r[3]}},"board":"$id"}]""" } ?: "[]"
        val manifest = """{"id":"${b.id}","name":"${b.name}","world":{"x":0,"y":0,"w":$W,"h":$H},"tile":512,"dpr":2,
            "levels":${levels.joinToString(",", "[", "]") { (z, cr) -> """{"z":$z,"cols":${cr.first},"rows":${cr.second}}""" }},
            "bg":"#eeece6","hits":$hits}"""
        val files = LinkedHashMap<String, ByteArray>()
        files["manifest.json"] = manifest.toByteArray()
        for ((l, lv) in levels.withIndex()) {
            val (z, cr) = lv
            val s = z * 2
            val full = Bitmap.createBitmap((W * s).toInt(), (H * s).toInt(), Bitmap.Config.ARGB_8888)
            val canvas = Canvas(full)
            canvas.drawColor(b.colour)
            b.hit?.let { (r, _) ->
                canvas.drawRect((r[0] * s).toFloat(), (r[1] * s).toFloat(), ((r[0] + r[2]) * s).toFloat(), ((r[1] + r[3]) * s).toFloat(), Paint().apply { color = SUB })
            }
            for (row in 0 until cr.second) for (col in 0 until cr.first) {
                val x = col * 512
                val y = row * 512
                val tile = Bitmap.createBitmap(full, x, y, minOf(512, full.width - x), minOf(512, full.height - y))
                files["$l/${col}_$row.webp"] = webp(tile)
                tile.recycle()
            }
            full.recycle()
        }
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { z ->
            for ((name, body) in files) {
                val e = ZipEntry(name)
                e.method = ZipEntry.STORED
                e.size = body.size.toLong()
                e.crc = CRC32().apply { update(body) }.value
                z.putNextEntry(e)
                z.write(body)
                z.closeEntry()
            }
        }
        return out.toByteArray()
    }

    private fun webp(b: Bitmap): ByteArray {
        val out = ByteArrayOutputStream()
        @Suppress("DEPRECATION")
        val format = if (Build.VERSION.SDK_INT >= 30) Bitmap.CompressFormat.WEBP_LOSSLESS else Bitmap.CompressFormat.WEBP
        b.compress(format, 100, out)
        return out.toByteArray()
    }

    companion object {
        const val W = 1000.0
        const val H = 800.0
        val ROOT = Color.rgb(46, 125, 50)
        val SUB = Color.rgb(21, 101, 192)
        val DEV = Color.rgb(123, 31, 162)
        /** The sub-board card on the root board: x, y, w, h in world px */
        val SUB_HIT = doubleArrayOf(600.0, 450.0, 300.0, 250.0)
    }
}
