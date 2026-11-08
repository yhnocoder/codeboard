package io.github.yhnocoder.codeboard

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.view.animation.DecelerateInterpolator
import android.widget.OverScroller
import io.github.yhnocoder.codeboard.core.BoardMath
import io.github.yhnocoder.codeboard.core.Camera
import io.github.yhnocoder.codeboard.core.TileRange
import io.github.yhnocoder.codeboard.core.Viewport
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** A board on screen: its tiles and where the camera is. */
class Shown(val store: TileStore, val cam: Camera) {
    val spec get() = store.spec
}

/**
 * Draws a board from its tiles and moves it like a map: one finger pans, two pinch and pan, a fling glides,
 * a double tap zooms. Only bitmaps move; nothing is laid out or allocated while drawing.
 */
@SuppressLint("ViewConstructor")
class BoardView(context: Context, private val cache: TileCache) : View(context) {
    /** A tap on a sub-board's area. */
    var onOpen: ((String) -> Unit)? = null

    var current: Shown? = null
        private set
    private var previous: Shown? = null
    private var fade = 1f
    private var fadeAnimator: ValueAnimator? = null
    private var fadeWaiting = false
    private var needsFit = false

    private val vp = Viewport()
    private val density = resources.displayMetrics.density

    // drawing scratch, reused every frame
    private val paint = Paint(Paint.FILTER_BITMAP_FLAG).apply { isFilterBitmap = true }
    private val src = Rect()
    private val dst = RectF()
    private val range = TileRange()
    private val around = TileRange()
    private val cover = TileRange()
    private val finer = TileRange()
    private val order = IntArray(32)

    // gestures
    private val config = ViewConfiguration.get(context)
    private val scroller = OverScroller(context)
    private var velocity: VelocityTracker? = null
    private var lastFx = 0.0
    private var lastFy = 0.0
    private var lastSpan = 0.0
    private var downX = 0f
    private var downY = 0f
    private var ignoring = false
    private var flingTx = 0.0
    private var flingTy = 0.0
    private val bounds = DoubleArray(4)
    private var camAnimator: ValueAnimator? = null
    private val animFrom = Camera()
    private val animTo = Camera()

    private val taps = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(e: MotionEvent) = true

        override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
            val s = current ?: return false
            if (fadeAnimator != null || fadeWaiting) return false
            val id = s.spec.hitAt(s.cam.worldX(e.x.toDouble()), s.cam.worldY(e.y.toDouble())) ?: return false
            onOpen?.invoke(id)
            return true
        }

        override fun onDoubleTap(e: MotionEvent): Boolean {
            val s = current ?: return false
            animateTo(BoardMath.doubleTapTarget(s.spec, vp, s.cam, e.x.toDouble(), e.y.toDouble(), Camera()))
            return true
        }
    })

    init {
        isClickable = true
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    fun setInsets(top: Int, bottom: Int) {
        vp.insetTop = top.toDouble()
        vp.insetBottom = bottom.toDouble()
        vp.pad = 12.0 * density
    }

    /**
     * Shows a board: at `cam`, or fitted when null. With `crossfade`, the board on screen stays until the
     * new one's coarsest tiles are decoded, then fades into it.
     */
    fun show(store: TileStore, cam: Camera?, crossfade: Boolean) {
        stopMotion()
        fadeAnimator?.cancel()
        fadeAnimator = null
        previous = if (crossfade) current else null
        val c = cam?.copy() ?: Camera()
        current = Shown(store, c)
        needsFit = cam == null
        if (vp.w > 0 && needsFit) {
            BoardMath.fit(store.spec, vp, c)
            needsFit = false
        }
        fade = 0f
        fadeWaiting = true
        if (store.coarseReady()) startFade() else postDelayed(fadeTimeout, 400)
        invalidate()
    }

    /** Shows no board (the paper only). */
    fun clear() {
        stopMotion()
        fadeAnimator?.cancel()
        fadeAnimator = null
        removeCallbacks(fadeTimeout)
        fadeWaiting = false
        previous = null
        current = null
        invalidate()
    }

    /** The camera of the board on screen, to keep on the back stack. */
    fun camera(): Camera? = current?.cam?.copy()

    fun fit() {
        val s = current ?: return
        animateTo(BoardMath.fit(s.spec, vp, Camera()))
    }

    /** A tile arrived. */
    fun tileArrived() {
        if (fadeWaiting && current?.store?.coarseReady() == true) startFade()
        postInvalidateOnAnimation()
    }

    private val fadeTimeout = Runnable { if (fadeWaiting) startFade() }

    private fun startFade() {
        if (!fadeWaiting) return
        fadeWaiting = false
        removeCallbacks(fadeTimeout)
        if (previous == null) {
            fade = 1f
            invalidate()
            return
        }
        fadeAnimator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 220
            interpolator = DecelerateInterpolator()
            addUpdateListener { fade = it.animatedValue as Float; invalidate() }
            addListener(object : android.animation.AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: android.animation.Animator) {
                    if (fadeAnimator === animation) {
                        fadeAnimator = null
                        previous = null
                        fade = 1f
                        invalidate()
                    }
                }
            })
            start()
        }
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        val ow = vp.w
        val oh = vp.h
        vp.w = w.toDouble()
        vp.h = h.toDouble()
        val s = current ?: return
        if (needsFit || ow <= 0) {
            BoardMath.fit(s.spec, vp, s.cam)
            needsFit = false
        } else {
            // keep the world point at the centre where it is (rotation, split screen)
            s.cam.tx += (vp.w - ow) / 2
            s.cam.ty += (vp.h - oh) / 2
            s.cam.zoom = BoardMath.clampZoom(s.spec, vp, s.cam.zoom)
            BoardMath.clampPan(s.spec, vp, s.cam)
        }
    }

    // ---- drawing ----

    override fun onDraw(canvas: Canvas) {
        cache.frame++
        val s = current ?: return
        if (scroller.computeScrollOffset()) {
            s.cam.tx = flingTx + scroller.currX
            s.cam.ty = flingTy + scroller.currY
            postInvalidateOnAnimation()
        }
        val p = previous
        if (p != null) drawBoard(canvas, p, false)
        if (fade >= 1f || p == null && !fadeWaiting) {
            drawBoard(canvas, s, true)
        } else {
            // the new board must still ask for its tiles while invisible
            requestTiles(s)
            if (fade > 0f) {
                val save = canvas.saveLayerAlpha(0f, 0f, width.toFloat(), height.toFloat(), (fade * 255).roundToInt())
                drawBoard(canvas, s, false)
                canvas.restoreToCount(save)
            } else if (p == null) {
                canvas.drawColor(s.spec.bg)
            }
        }
    }

    private fun requestTiles(s: Shown) {
        val level = BoardMath.chooseLevel(s.spec, s.cam.zoom)
        BoardMath.visibleTiles(s.spec, level, s.cam, vp, range)
        BoardMath.visibleTiles(s.spec, level, s.cam, vp, around, margin = 1)
        cache.want(s.store, range, around)
    }

    private fun drawBoard(canvas: Canvas, s: Shown, request: Boolean) {
        val spec = s.spec
        val store = s.store
        canvas.drawColor(spec.bg)
        if (request) requestTiles(s)
        val level = BoardMath.chooseLevel(spec, s.cam.zoom)
        BoardMath.visibleTiles(spec, level, s.cam, vp, range)
        if (range.isEmpty) return
        val frame = cache.frame
        for (r in range.r0..range.r1) for (c in range.c0..range.c1) {
            val b = store.get(level, c, r, frame)
            if (b != null) {
                drawTile(canvas, s, level, c, r, b, -NO_CLIP, -NO_CLIP, NO_CLIP, NO_CLIP)
            } else if (store.state(level, c, r) != MISSING) {
                drawCover(canvas, s, level, c, r)
            }
        }
    }

    /**
     * In place of tile (c, r) of `level`: the nearest level whose tiles over that area are all decoded
     * (coarser first, then the finer one), and on top whatever of the finer level is decoded there.
     */
    private fun drawCover(canvas: Canvas, s: Shown, level: Int, c: Int, r: Int) {
        val spec = s.spec
        val store = s.store
        val x0 = spec.tileX(level, c)
        val y0 = spec.tileY(level, r)
        val x1 = min(spec.world.right, x0 + spec.span(level))
        val y1 = min(spec.world.bottom, y0 + spec.span(level))
        val n = BoardMath.coverOrder(spec.levels.size, level, order)
        var full = -1
        for (i in 0 until n) {
            BoardMath.coverTiles(spec, level, c, r, order[i], cover)
            if (!cover.isEmpty && store.allReady(cover)) {
                full = order[i]
                break
            }
        }
        if (full >= 0) drawRange(canvas, s, cover, x0, y0, x1, y1)
        if (level > 0 && full != level - 1) {
            BoardMath.coverTiles(spec, level, c, r, level - 1, finer)
            if (!finer.isEmpty) drawRange(canvas, s, finer, x0, y0, x1, y1)
        }
    }

    private fun drawRange(canvas: Canvas, s: Shown, tiles: TileRange, x0: Double, y0: Double, x1: Double, y1: Double) {
        val frame = cache.frame
        for (r in tiles.r0..tiles.r1) for (c in tiles.c0..tiles.c1) {
            val b = s.store.get(tiles.level, c, r, frame) ?: continue
            drawTile(canvas, s, tiles.level, c, r, b, x0, y0, x1, y1)
        }
    }

    /** Draws the part of a tile inside the world rectangle (x0, y0)–(x1, y1), screen edges on whole pixels. */
    private fun drawTile(
        canvas: Canvas, s: Shown, level: Int, c: Int, r: Int, b: Bitmap,
        x0: Double, y0: Double, x1: Double, y1: Double,
    ) {
        val spec = s.spec
        val scale = spec.scale(level)
        val tx0 = spec.tileX(level, c)
        val ty0 = spec.tileY(level, r)
        // edge tiles are cropped: their real size decides how much world they cover
        val tx1 = tx0 + b.width / scale
        val ty1 = ty0 + b.height / scale
        val ix0 = max(tx0, x0)
        val iy0 = max(ty0, y0)
        val ix1 = min(tx1, x1)
        val iy1 = min(ty1, y1)
        if (ix0 >= ix1 || iy0 >= iy1) return
        src.set(
            floor((ix0 - tx0) * scale).toInt(), floor((iy0 - ty0) * scale).toInt(),
            min(b.width, ceil((ix1 - tx0) * scale).toInt()), min(b.height, ceil((iy1 - ty0) * scale).toInt()),
        )
        val cam = s.cam
        dst.set(
            cam.screenX(ix0).roundToInt().toFloat(), cam.screenY(iy0).roundToInt().toFloat(),
            cam.screenX(ix1).roundToInt().toFloat(), cam.screenY(iy1).roundToInt().toFloat(),
        )
        if (dst.right <= 0f || dst.bottom <= 0f || dst.left >= width || dst.top >= height) return
        canvas.drawBitmap(b, src, dst, paint)
    }

    // ---- gestures ----

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
        val s = current ?: return false
        // a gesture that starts while boards crossfade is ignored to its end
        if (e.actionMasked == MotionEvent.ACTION_DOWN) ignoring = fadeAnimator != null || fadeWaiting
        if (ignoring) {
            if (e.actionMasked == MotionEvent.ACTION_UP || e.actionMasked == MotionEvent.ACTION_CANCEL) ignoring = false
            return true
        }
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                stopMotion()
                downX = e.x
                downY = e.y
                velocity?.recycle()
                velocity = VelocityTracker.obtain().also { it.addMovement(e) }
                focal(e, -1)
                parent?.requestDisallowInterceptTouchEvent(true)
            }
            MotionEvent.ACTION_POINTER_DOWN -> {
                // a finger more or less: start measuring from where the fingers are now, so nothing jumps
                focal(e, -1)
                velocity?.clear()
            }
            MotionEvent.ACTION_POINTER_UP -> {
                focal(e, e.actionIndex)
                velocity?.clear()
            }
            MotionEvent.ACTION_MOVE -> {
                velocity?.addMovement(e)
                if (camAnimator != null) {
                    // the second touch of a double tap: let the zoom run unless the finger really moves
                    if (e.pointerCount == 1 && hypot(e.x - downX, e.y - downY) < config.scaledTouchSlop) {
                        focal(e, -1)
                        taps.onTouchEvent(e)
                        return true
                    }
                    stopMotion()
                }
                val fx0 = lastFx
                val fy0 = lastFy
                val span0 = lastSpan
                focal(e, -1)
                val factor = if (e.pointerCount >= 2 && span0 > 0 && lastSpan > 0) lastSpan / span0 else 1.0
                BoardMath.panZoom(s.spec, vp, s.cam, fx0, fy0, lastFx, lastFy, factor)
                invalidate()
            }
            MotionEvent.ACTION_UP -> {
                val v = velocity
                if (v != null) {
                    v.addMovement(e)
                    v.computeCurrentVelocity(1000, config.scaledMaximumFlingVelocity.toFloat())
                    val id = e.getPointerId(0)
                    fling(s, v.getXVelocity(id), v.getYVelocity(id))
                }
                velocity?.recycle()
                velocity = null
            }
            MotionEvent.ACTION_CANCEL -> {
                velocity?.recycle()
                velocity = null
            }
        }
        taps.onTouchEvent(e)
        return true
    }

    /** The average of the fingers' positions and their average distance from it, leaving out finger `skip`. */
    private fun focal(e: MotionEvent, skip: Int) {
        var sx = 0.0
        var sy = 0.0
        var n = 0
        for (i in 0 until e.pointerCount) if (i != skip) {
            sx += e.getX(i); sy += e.getY(i); n++
        }
        if (n == 0) return
        val fx = sx / n
        val fy = sy / n
        var span = 0.0
        for (i in 0 until e.pointerCount) if (i != skip) span += hypot(e.getX(i) - fx, e.getY(i) - fy)
        lastFx = fx
        lastFy = fy
        lastSpan = if (n >= 2) span / n else 0.0
    }

    private fun fling(s: Shown, vx: Float, vy: Float) {
        if (hypot(vx, vy) < config.scaledMinimumFlingVelocity) return
        BoardMath.panBounds(s.spec, vp, s.cam.zoom, bounds)
        flingTx = s.cam.tx
        flingTy = s.cam.ty
        scroller.fling(
            0, 0, vx.roundToInt(), vy.roundToInt(),
            min(0, (bounds[0] - flingTx).toInt()), max(0, (bounds[1] - flingTx).toInt()),
            min(0, (bounds[2] - flingTy).toInt()), max(0, (bounds[3] - flingTy).toInt()),
        )
        postInvalidateOnAnimation()
    }

    private fun stopMotion() {
        scroller.forceFinished(true)
        camAnimator?.cancel()
        camAnimator = null
    }

    private fun animateTo(target: Camera) {
        val s = current ?: return
        stopMotion()
        if (abs(target.zoom - s.cam.zoom) < 1e-9 && abs(target.tx - s.cam.tx) < 0.5 && abs(target.ty - s.cam.ty) < 0.5) return
        animFrom.set(s.cam)
        animTo.set(target)
        camAnimator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 300
            interpolator = DecelerateInterpolator(1.6f)
            addUpdateListener {
                BoardMath.interpolate(animFrom, animTo, (it.animatedValue as Float).toDouble(), s.cam)
                invalidate()
            }
            start()
        }
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        stopMotion()
        fadeAnimator?.cancel()
        removeCallbacks(fadeTimeout)
    }

    private companion object {
        const val NO_CLIP = 1e18
    }
}
