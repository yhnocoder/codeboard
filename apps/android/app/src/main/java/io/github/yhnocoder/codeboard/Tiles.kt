package io.github.yhnocoder.codeboard

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import io.github.yhnocoder.codeboard.core.BoardSpec
import io.github.yhnocoder.codeboard.core.TileRange
import java.io.IOException
import java.util.zip.ZipFile
import java.util.concurrent.PriorityBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicIntegerArray

const val NONE = 0
const val QUEUED = 1
const val LOADED = 2
const val MISSING = 3

/**
 * One board's tiles: per level, one slot per (col, row) holding the decoded bitmap, its load state and
 * when it was last drawn. Bitmaps are written and read on the main thread only; the state is shared with
 * the decoder threads. Arrays rather than an LruCache keep drawing free of allocations (no boxed keys).
 */
class TileStore(val spec: BoardSpec, val zip: ZipFile) {
    val coarsest = spec.levels.size - 1
    val bitmaps: Array<Array<Bitmap?>> = Array(spec.levels.size) { arrayOfNulls(spec.levels[it].cols * spec.levels[it].rows) }
    val used: Array<LongArray> = Array(spec.levels.size) { LongArray(spec.levels[it].cols * spec.levels[it].rows) }
    val states: Array<AtomicIntegerArray> = Array(spec.levels.size) { AtomicIntegerArray(spec.levels[it].cols * spec.levels[it].rows) }

    @Volatile var released = false

    fun index(level: Int, c: Int, r: Int) = r * spec.levels[level].cols + c

    fun state(level: Int, c: Int, r: Int) = states[level].get(index(level, c, r))

    /** Drawable now: decoded, or known to have no image (drawn as the board's background). */
    fun ready(level: Int, c: Int, r: Int): Boolean {
        val s = state(level, c, r)
        return s == LOADED || s == MISSING
    }

    fun allReady(range: TileRange): Boolean {
        for (r in range.r0..range.r1) for (c in range.c0..range.c1) if (!ready(range.level, c, r)) return false
        return true
    }

    fun coarseReady(): Boolean {
        val lv = spec.levels[coarsest]
        for (i in 0 until lv.cols * lv.rows) {
            val s = states[coarsest].get(i)
            if (s != LOADED && s != MISSING) return false
        }
        return true
    }

    fun get(level: Int, c: Int, r: Int, frame: Long): Bitmap? {
        val i = index(level, c, r)
        val b = bitmaps[level][i]
        if (b != null) used[level][i] = frame
        return b
    }
}

/** The tiles the view wants decoded: one level of one board, as an inclusive range. Replaced, never changed. */
private class Window(val store: TileStore, val level: Int, val c0: Int, val r0: Int, val c1: Int, val r1: Int) {
    fun same(s: TileStore, l: Int, r: TileRange) = s === store && l == level && r.c0 == c0 && r.r0 == r0 && r.c1 == c1 && r.r1 == r1
    fun has(s: TileStore, l: Int, c: Int, r: Int) = s === store && l == level && c in c0..c1 && r in r0..r1
}

/**
 * Decodes tiles from the boards' zips (stored, so each tile is read in place) on background threads, newest requests first, and keeps them within
 * a byte budget, evicting the least recently drawn. The coarsest level of every open board stays, so there
 * is always something to draw under a tile that is not decoded yet.
 */
class TileCache(private val budget: Long, private val onTile: () -> Unit) {
    private val main = Handler(Looper.getMainLooper())
    private val threads = Runtime.getRuntime().availableProcessors().coerceIn(2, 4)
    private val executor = ThreadPoolExecutor(threads, threads, 30, TimeUnit.SECONDS, PriorityBlockingQueue()).apply {
        allowCoreThreadTimeOut(true)
    }
    private val stores = ArrayList<TileStore>()
    private var bytes = 0L
    private var seq = 0L

    /** Bumped once per drawn frame; a tile drawn in this frame is never evicted. */
    var frame = 1L

    @Volatile private var window: Window? = null

    fun open(spec: BoardSpec, zip: ZipFile): TileStore {
        val s = TileStore(spec, zip)
        stores.add(s)
        val lv = spec.levels[s.coarsest]
        for (r in 0 until lv.rows) for (c in 0 until lv.cols) enqueue(s, s.coarsest, c, r, Long.MAX_VALUE)
        return s
    }

    fun release(s: TileStore) {
        if (!stores.remove(s)) return
        s.released = true
        try {
            s.zip.close()
        } catch (e: IOException) {
        }
        for (l in s.bitmaps.indices) for (i in s.bitmaps[l].indices) {
            val b = s.bitmaps[l][i] ?: continue
            bytes -= size(b)
            s.bitmaps[l][i] = null
        }
    }

    /**
     * Asks for the tiles of `visible` (first) and `around` it (after) at one level of `store`; anything
     * queued for other tiles is dropped when its turn comes. Allocates only when something new is queued.
     */
    fun want(store: TileStore, visible: TileRange, around: TileRange) {
        val level = visible.level
        val w = window
        if (w == null || !w.same(store, level, around)) {
            window = Window(store, level, around.c0, around.r0, around.c1, around.r1)
        }
        if (visible.isEmpty) return
        val base = ++seq * 2
        for (r in visible.r0..visible.r1) for (c in visible.c0..visible.c1) {
            if (store.state(level, c, r) == NONE) enqueue(store, level, c, r, base + 1)
        }
        for (r in around.r0..around.r1) for (c in around.c0..around.c1) {
            if (!visible.contains(c, r) && store.state(level, c, r) == NONE) enqueue(store, level, c, r, base)
        }
    }

    private fun wanted(s: TileStore, level: Int, c: Int, r: Int): Boolean {
        if (s.released) return false
        if (level == s.coarsest) return true
        return window?.has(s, level, c, r) == true
    }

    private fun enqueue(s: TileStore, level: Int, c: Int, r: Int, priority: Long) {
        val i = s.index(level, c, r)
        if (!s.states[level].compareAndSet(i, NONE, QUEUED)) return
        executor.execute(Job(s, level, c, r, priority))
    }

    private inner class Job(
        val s: TileStore, val level: Int, val c: Int, val r: Int, val priority: Long,
    ) : Runnable, Comparable<Job> {
        override fun compareTo(other: Job) = other.priority.compareTo(priority)

        override fun run() {
            val i = s.index(level, c, r)
            if (!wanted(s, level, c, r)) {
                s.states[level].set(i, NONE)
                return
            }
            val bmp = try {
                // no entry: the tile is plain background
                val entry = s.zip.getEntry("$level/${c}_$r.webp")
                if (entry == null) null else s.zip.getInputStream(entry).use { decode(it, level == s.coarsest) }
            } catch (e: Exception) {
                // the zip was closed under us (board released) or could not be read: try again if still wanted
                s.states[level].set(i, NONE)
                return
            } catch (e: OutOfMemoryError) {
                s.states[level].set(i, NONE)
                return
            }
            main.post { deliver(s, level, i, bmp) }
        }
    }

    private fun deliver(s: TileStore, level: Int, i: Int, bmp: Bitmap?) {
        if (s.released) return
        if (bmp == null) {
            s.states[level].set(i, MISSING)
        } else {
            s.bitmaps[level][i] = bmp
            s.used[level][i] = frame
            bytes += size(bmp)
            s.states[level].set(i, LOADED)
            evict()
        }
        onTile()
    }

    private fun evict() {
        while (bytes > budget) {
            var best: TileStore? = null
            var bestLevel = 0
            var bestIndex = 0
            var oldest = frame
            for (s in stores) for (l in 0 until s.coarsest) {
                val u = s.used[l]
                val b = s.bitmaps[l]
                for (i in b.indices) if (b[i] != null && u[i] < oldest) {
                    oldest = u[i]; best = s; bestLevel = l; bestIndex = i
                }
            }
            val s = best ?: return // everything left is on screen or a coarsest level
            bytes -= size(s.bitmaps[bestLevel][bestIndex]!!)
            s.bitmaps[bestLevel][bestIndex] = null
            s.states[bestLevel].set(bestIndex, NONE)
        }
    }

    private fun size(b: Bitmap) = b.width.toLong() * b.height * 4

    companion object {
        /**
         * Tiles are decoded straight into GPU memory on the decoder thread, so nothing is uploaded when one is
         * first drawn. The coarsest level is also drawn far below its own scale (fitting a big board), so it
         * is a software bitmap with mipmaps instead, which keeps it smooth there; it is only a few tiles.
         */
        private fun decode(input: java.io.InputStream, coarsest: Boolean): Bitmap? {
            val o = BitmapFactory.Options()
            o.inPreferredConfig = if (coarsest) Bitmap.Config.ARGB_8888 else Bitmap.Config.HARDWARE
            val b = BitmapFactory.decodeStream(input, null, o) ?: return null
            if (coarsest) {
                b.setHasMipMap(true)
                b.prepareToDraw()
            }
            return b
        }
    }
}
