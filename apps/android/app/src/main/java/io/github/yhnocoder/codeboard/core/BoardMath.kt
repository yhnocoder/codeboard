package io.github.yhnocoder.codeboard.core

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min

// Plain Kotlin, no Android: the camera, level choice and tile cover, tested on the JVM.

class WorldRect(val x: Double, val y: Double, val w: Double, val h: Double) {
    val right get() = x + w
    val bottom get() = y + h
    fun contains(px: Double, py: Double) = px >= x && px <= right && py >= y && py <= bottom
}

/** One zoom level of tiles: at this level one world px is `z * dpr` image px. */
class Level(val z: Double, val cols: Int, val rows: Int)

class Hit(val rect: WorldRect, val board: String)

class BoardSpec(
    val id: String,
    val name: String,
    val world: WorldRect,
    val tile: Int,
    val dpr: Double,
    /** Descending z: index 0 is the sharpest. */
    val levels: List<Level>,
    val bg: Int,
    val hits: List<Hit>,
) {
    /** Image px per world px at a level. */
    fun scale(level: Int) = levels[level].z * dpr

    /** World px covered by a full tile edge at a level. */
    fun span(level: Int) = tile / scale(level)

    fun tileX(level: Int, col: Int) = world.x + col * span(level)
    fun tileY(level: Int, row: Int) = world.y + row * span(level)

    /** The board a tap at this world point opens, or null. The last hit drawn wins. */
    fun hitAt(wx: Double, wy: Double): String? {
        for (i in hits.indices.reversed()) if (hits[i].rect.contains(wx, wy)) return hits[i].board
        return null
    }
}

/** screen = world * zoom + t. `zoom` is screen px per world px. */
class Camera(var tx: Double = 0.0, var ty: Double = 0.0, var zoom: Double = 1.0) {
    fun set(o: Camera) {
        tx = o.tx; ty = o.ty; zoom = o.zoom
    }

    fun copy() = Camera(tx, ty, zoom)
    fun screenX(wx: Double) = wx * zoom + tx
    fun screenY(wy: Double) = wy * zoom + ty
    fun worldX(sx: Double) = (sx - tx) / zoom
    fun worldY(sy: Double) = (sy - ty) / zoom
    override fun toString() = "Camera($tx, $ty, $zoom)"
}

/** The view's size and the parts of it covered by bars (fit keeps the board out of them). */
class Viewport(
    var w: Double = 0.0,
    var h: Double = 0.0,
    var insetTop: Double = 0.0,
    var insetBottom: Double = 0.0,
    var pad: Double = 0.0,
)

/** Inclusive tile range at one level; empty when c0 > c1 or r0 > r1. Mutable so drawing reuses one. */
class TileRange {
    var level = 0
    var c0 = 0
    var r0 = 0
    var c1 = -1
    var r1 = -1
    val isEmpty get() = c0 > c1 || r0 > r1
    val count get() = if (isEmpty) 0 else (c1 - c0 + 1) * (r1 - r0 + 1)
    fun contains(c: Int, r: Int) = c in c0..c1 && r in r0..r1
    fun set(level: Int, c0: Int, r0: Int, c1: Int, r1: Int) {
        this.level = level; this.c0 = c0; this.r0 = r0; this.c1 = c1; this.r1 = r1
    }
}

object BoardMath {
    const val MIN_FIT = 0.6
    const val MAX_SHARP = 1.25

    fun fitZoom(world: WorldRect, vp: Viewport): Double {
        val aw = max(1.0, vp.w - 2 * vp.pad)
        val ah = max(1.0, vp.h - vp.insetTop - vp.insetBottom - 2 * vp.pad)
        return min(aw / world.w, ah / world.h)
    }

    /** The whole board, centred in the part of the view below the top bar. */
    fun fit(spec: BoardSpec, vp: Viewport, out: Camera): Camera {
        val z = clampZoom(spec, vp, fitZoom(spec.world, vp))
        val cx = vp.w / 2
        val cy = vp.insetTop + (vp.h - vp.insetTop - vp.insetBottom) / 2
        out.zoom = z
        out.tx = cx - (spec.world.x + spec.world.w / 2) * z
        out.ty = cy - (spec.world.y + spec.world.h / 2) * z
        return out
    }

    fun minZoom(spec: BoardSpec, vp: Viewport) = MIN_FIT * fitZoom(spec.world, vp)

    /** Text at the sharpest level stays crisp up to a little past its own resolution. */
    fun maxZoom(spec: BoardSpec, vp: Viewport) = max(spec.scale(0) * MAX_SHARP, fitZoom(spec.world, vp))

    fun clampZoom(spec: BoardSpec, vp: Viewport, z: Double) = min(maxZoom(spec, vp), max(minZoom(spec, vp), z))

    /** Sets the zoom keeping the world point under the screen point (fx, fy) where it is. */
    fun zoomAbout(cam: Camera, zoom: Double, fx: Double, fy: Double) {
        val wx = cam.worldX(fx)
        val wy = cam.worldY(fy)
        cam.zoom = zoom
        cam.tx = fx - wx * zoom
        cam.ty = fy - wy * zoom
    }

    /**
     * One step of a one- or two-finger gesture: the world point that was under the old focal point
     * ends up under the new one, with the zoom multiplied by `factor` (clamped).
     */
    fun panZoom(
        spec: BoardSpec, vp: Viewport, cam: Camera,
        lastFx: Double, lastFy: Double, fx: Double, fy: Double, factor: Double,
    ) {
        val wx = cam.worldX(lastFx)
        val wy = cam.worldY(lastFy)
        val z = clampZoom(spec, vp, cam.zoom * factor)
        cam.zoom = z
        cam.tx = fx - wx * z
        cam.ty = fy - wy * z
        clampPan(spec, vp, cam)
    }

    /**
     * The allowed tx / ty for a zoom: at least a third of the screen (or the whole board, when it is
     * smaller than that) stays over the board. out = [txMin, txMax, tyMin, tyMax].
     */
    fun panBounds(spec: BoardSpec, vp: Viewport, zoom: Double, out: DoubleArray) {
        val bw = spec.world.w * zoom
        val bh = spec.world.h * zoom
        val mx = min(vp.w / 3, bw)
        val my = min(vp.h / 3, bh)
        // board left = world.x*zoom + tx <= w - mx ; board right = left + bw >= mx
        out[0] = mx - bw - spec.world.x * zoom
        out[1] = vp.w - mx - spec.world.x * zoom
        out[2] = my - bh - spec.world.y * zoom
        out[3] = vp.h - my - spec.world.y * zoom
    }

    private val bounds = DoubleArray(4)

    fun clampPan(spec: BoardSpec, vp: Viewport, cam: Camera) {
        panBounds(spec, vp, cam.zoom, bounds)
        cam.tx = min(bounds[1], max(bounds[0], cam.tx))
        cam.ty = min(bounds[3], max(bounds[2], cam.ty))
    }

    /** The coarsest level whose image px per world px is at least the screen's; the sharpest when none is. */
    fun chooseLevel(spec: BoardSpec, zoom: Double): Int {
        for (i in spec.levels.indices.reversed()) if (spec.scale(i) >= zoom * (1 - 1e-9)) return i
        return 0
    }

    /** The tiles at a level that intersect a world rectangle (open at its far edges). */
    fun tilesFor(spec: BoardSpec, level: Int, x0: Double, y0: Double, x1: Double, y1: Double, out: TileRange): TileRange {
        val lv = spec.levels[level]
        val span = spec.span(level)
        val c0 = max(0, floor((x0 - spec.world.x) / span).toInt())
        val r0 = max(0, floor((y0 - spec.world.y) / span).toInt())
        val c1 = min(lv.cols - 1, ceil((x1 - spec.world.x) / span).toInt() - 1)
        val r1 = min(lv.rows - 1, ceil((y1 - spec.world.y) / span).toInt() - 1)
        val empty = x1 <= spec.world.x || y1 <= spec.world.y || x0 >= spec.world.right || y0 >= spec.world.bottom
        if (empty) out.set(level, 0, 0, -1, -1) else out.set(level, c0, r0, c1, r1)
        return out
    }

    /** The tiles at a level the view shows, plus `margin` tiles around them. */
    fun visibleTiles(spec: BoardSpec, level: Int, cam: Camera, vp: Viewport, out: TileRange, margin: Int = 0): TileRange {
        tilesFor(spec, level, cam.worldX(0.0), cam.worldY(0.0), cam.worldX(vp.w), cam.worldY(vp.h), out)
        if (margin > 0 && !out.isEmpty) {
            val lv = spec.levels[level]
            out.set(level, max(0, out.c0 - margin), max(0, out.r0 - margin), min(lv.cols - 1, out.c1 + margin), min(lv.rows - 1, out.r1 + margin))
        }
        return out
    }

    /**
     * Where to look for something to draw in place of a tile of `level` that is not decoded yet:
     * the coarser levels nearest first, then the next finer one. Writes level indices to out, returns how many.
     */
    fun coverOrder(levelCount: Int, level: Int, out: IntArray): Int {
        var n = 0
        for (k in level + 1 until levelCount) out[n++] = k
        if (level > 0) out[n++] = level - 1
        return n
    }

    /** The tiles of level `other` that cover tile (col, row) of `level` (clipped to the board). */
    fun coverTiles(spec: BoardSpec, level: Int, col: Int, row: Int, other: Int, out: TileRange): TileRange {
        val span = spec.span(level)
        val x0 = spec.tileX(level, col)
        val y0 = spec.tileY(level, row)
        val x1 = min(spec.world.right, x0 + span)
        val y1 = min(spec.world.bottom, y0 + span)
        return tilesFor(spec, other, x0, y0, x1, y1, out)
    }

    /**
     * The camera a fraction `f` of the way from a to b: the zoom moves geometrically, about the one screen
     * point both cameras show the same world point at (so a zoom about a tap stays about the tap).
     */
    fun interpolate(a: Camera, b: Camera, f: Double, out: Camera): Camera {
        val r = b.zoom / a.zoom
        if (abs(ln(r)) < 1e-4) {
            out.zoom = a.zoom + (b.zoom - a.zoom) * f
            out.tx = a.tx + (b.tx - a.tx) * f
            out.ty = a.ty + (b.ty - a.ty) * f
            return out
        }
        val z = a.zoom * exp(ln(r) * f)
        val px = (a.tx * b.zoom - b.tx * a.zoom) / (b.zoom - a.zoom)
        val py = (a.ty * b.zoom - b.ty * a.zoom) / (b.zoom - a.zoom)
        out.zoom = z
        out.tx = px - (px - a.tx) * z / a.zoom
        out.ty = py - (py - a.ty) * z / a.zoom
        return out
    }

    /** The double-tap target: ×2 about the tap, or the fitted view when already near the maximum. */
    fun doubleTapTarget(spec: BoardSpec, vp: Viewport, cam: Camera, fx: Double, fy: Double, out: Camera): Camera {
        val zmax = maxZoom(spec, vp)
        if (cam.zoom >= zmax * 0.9) return fit(spec, vp, out)
        out.set(cam)
        zoomAbout(out, min(zmax, cam.zoom * 2), fx, fy)
        clampPan(spec, vp, out)
        return out
    }
}
