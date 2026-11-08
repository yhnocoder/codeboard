package io.github.yhnocoder.codeboard.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BoardMathTest {
    // The example manifest's shape: world (-80, -60, 4200 x 6100), 512 px tiles, dpr 2.
    private val spec = BoardSpec(
        id = "b", name = "Board",
        world = WorldRect(-80.0, -60.0, 4200.0, 6100.0),
        tile = 512, dpr = 2.0,
        levels = listOf(
            Level(1.0, 17, 24), Level(0.5, 9, 12), Level(0.25, 5, 6), Level(0.125, 3, 3), Level(0.0625, 2, 2),
        ),
        bg = 0, hits = listOf(Hit(WorldRect(100.0, 100.0, 200.0, 100.0), "sub")),
    )
    private val vp = Viewport(w = 1080.0, h = 2400.0, insetTop = 200.0, insetBottom = 60.0, pad = 20.0)
    private val eps = 1e-6

    @Test fun fitShowsTheWholeBoardCentredBelowTheBar() {
        val cam = BoardMath.fit(spec, vp, Camera())
        val left = cam.screenX(spec.world.x)
        val right = cam.screenX(spec.world.right)
        val top = cam.screenY(spec.world.y)
        val bottom = cam.screenY(spec.world.bottom)
        assertTrue(left >= vp.pad - eps && right <= vp.w - vp.pad + eps)
        assertTrue(top >= vp.insetTop + vp.pad - eps && bottom <= vp.h - vp.insetBottom - vp.pad + eps)
        // fills one dimension
        assertTrue(abs(right - left - (vp.w - 2 * vp.pad)) < eps || abs(bottom - top - (vp.h - 260 - 2 * vp.pad)) < eps)
        assertEquals((left + right) / 2, vp.w / 2, eps)
        assertEquals((top + bottom) / 2, vp.insetTop + (vp.h - vp.insetTop - vp.insetBottom) / 2, eps)
    }

    @Test fun zoomLimitsAreAroundFitAndTheSharpestLevel() {
        val fit = BoardMath.fitZoom(spec.world, vp)
        assertEquals(0.6 * fit, BoardMath.minZoom(spec, vp), eps)
        assertEquals(2.0 * 1.25, BoardMath.maxZoom(spec, vp), eps)
        assertEquals(2.5, BoardMath.clampZoom(spec, vp, 100.0), eps)
        assertEquals(0.6 * fit, BoardMath.clampZoom(spec, vp, 0.0001), eps)
    }

    @Test fun zoomAboutKeepsTheFocalWorldPoint() {
        val cam = Camera(13.0, -40.0, 0.3)
        val wx = cam.worldX(500.0)
        val wy = cam.worldY(900.0)
        BoardMath.zoomAbout(cam, 1.7, 500.0, 900.0)
        assertEquals(1.7, cam.zoom, eps)
        assertEquals(500.0, cam.screenX(wx), eps)
        assertEquals(900.0, cam.screenY(wy), eps)
    }

    @Test fun pinchKeepsTheWorldPointUnderTheMovingFingers() {
        val cam = Camera(0.0, 0.0, 0.5)
        BoardMath.fit(spec, vp, cam)
        BoardMath.zoomAbout(cam, 1.0, 540.0, 1200.0) // well inside the board, away from the pan limits
        val wx = cam.worldX(500.0)
        val wy = cam.worldY(1000.0)
        // focal point moves (530, 1040) while the fingers spread 1.3x
        BoardMath.panZoom(spec, vp, cam, 500.0, 1000.0, 530.0, 1040.0, 1.3)
        assertEquals(1.3, cam.zoom, eps)
        assertEquals(530.0, cam.screenX(wx), eps)
        assertEquals(1040.0, cam.screenY(wy), eps)
        // a one-finger step is a pure pan by the finger's movement
        val tx = cam.tx
        BoardMath.panZoom(spec, vp, cam, 530.0, 1040.0, 520.0, 1040.0, 1.0)
        assertEquals(tx - 10, cam.tx, eps)
        assertEquals(1.3, cam.zoom, eps)
    }

    @Test fun panKeepsAThirdOfTheScreenOverTheBoard() {
        val cam = Camera(0.0, 0.0, 1.0)
        cam.tx = 1e6; cam.ty = 1e6
        BoardMath.clampPan(spec, vp, cam)
        assertEquals(vp.w - vp.w / 3, cam.screenX(spec.world.x), eps)
        assertEquals(vp.h - vp.h / 3, cam.screenY(spec.world.y), eps)
        cam.tx = -1e6; cam.ty = -1e6
        BoardMath.clampPan(spec, vp, cam)
        assertEquals(vp.w / 3, cam.screenX(spec.world.right), eps)
        assertEquals(vp.h / 3, cam.screenY(spec.world.bottom), eps)
        // a board smaller than a third of the screen stays wholly on screen
        cam.zoom = 0.01; cam.tx = 1e6
        BoardMath.clampPan(spec, vp, cam)
        assertEquals(vp.w, cam.screenX(spec.world.right), eps)
    }

    @Test fun levelIsTheCoarsestAtLeastAsSharpAsTheScreen() {
        assertEquals(0, BoardMath.chooseLevel(spec, 2.0)) // z 1 * dpr 2
        assertEquals(0, BoardMath.chooseLevel(spec, 1.5))
        assertEquals(1, BoardMath.chooseLevel(spec, 1.0))
        assertEquals(2, BoardMath.chooseLevel(spec, 0.4))
        assertEquals(3, BoardMath.chooseLevel(spec, 0.25))
        assertEquals(4, BoardMath.chooseLevel(spec, 0.05))
        assertEquals(0, BoardMath.chooseLevel(spec, 2.5)) // past the sharpest: still the sharpest
    }

    @Test fun visibleTilesCoverTheViewAndAreClampedToTheLevel() {
        val cam = Camera(0.0, 0.0, 1.0)
        // world (-80,-60) at the top left of the screen, 1:1
        cam.tx = 80.0; cam.ty = 60.0
        val r = BoardMath.visibleTiles(spec, 1, cam, vp, TileRange())
        // level 1: span 512 world px; screen 1080 x 2400 -> cols 0..2, rows 0..4
        assertEquals(0, r.c0); assertEquals(2, r.c1)
        assertEquals(0, r.r0); assertEquals(4, r.r1)
        // margin is clamped to the level's grid
        BoardMath.visibleTiles(spec, 1, cam, vp, r, margin = 1)
        assertEquals(0, r.c0); assertEquals(3, r.c1); assertEquals(5, r.r1)
        // looking right of the board: nothing
        cam.tx = -10000.0
        assertTrue(BoardMath.visibleTiles(spec, 1, cam, vp, r).isEmpty)
        // zoomed far out: everything, but no more than the level has
        cam.zoom = 0.01; cam.tx = 500.0; cam.ty = 500.0
        BoardMath.visibleTiles(spec, 0, cam, vp, r)
        assertEquals(17 * 24, r.count)
    }

    @Test fun tileEdgesFollowTheManifestFormula() {
        // at level i tile col covers x from world.x + col * tile / (z * dpr)
        assertEquals(-80.0 + 3 * 512 / (0.5 * 2), spec.tileX(1, 3), eps)
        assertEquals(-60.0 + 2 * 512 / (0.25 * 2), spec.tileY(2, 2), eps)
    }

    @Test fun fallbackLooksAtCoarserLevelsThenTheFinerOne() {
        val out = IntArray(8)
        val n = BoardMath.coverOrder(5, 2, out)
        assertEquals(listOf(3, 4, 1), out.take(n))
        assertEquals(listOf(1, 2, 3, 4), out.take(BoardMath.coverOrder(5, 0, out)))
        assertEquals(listOf(3), out.take(BoardMath.coverOrder(5, 4, out)))
    }

    @Test fun coverTilesFindTheCoarserTileUnderAFinerOne() {
        val r = TileRange()
        // level 0 tile (5, 7) spans 256 world px; level 1 spans 512, so it lies in level-1 tile (2, 3)
        BoardMath.coverTiles(spec, 0, 5, 7, 1, r)
        assertEquals(2, r.c0); assertEquals(2, r.c1); assertEquals(3, r.r0); assertEquals(3, r.r1)
        // a level-1 tile is covered by 2 x 2 level-0 tiles
        BoardMath.coverTiles(spec, 1, 2, 3, 0, r)
        assertEquals(4, r.c0); assertEquals(5, r.c1); assertEquals(6, r.r0); assertEquals(7, r.r1)
        // the coarsest level covers everything with its few tiles
        BoardMath.coverTiles(spec, 0, 16, 23, 4, r)
        assertEquals(1, r.c0); assertEquals(1, r.r0)
        assertFalse(r.isEmpty)
    }

    @Test fun interpolationEndsAtBothCamerasAndZoomsAboutTheTap() {
        val a = Camera(10.0, 20.0, 0.5)
        val b = a.copy()
        BoardMath.zoomAbout(b, 1.0, 300.0, 700.0)
        val out = Camera()
        BoardMath.interpolate(a, b, 0.0, out)
        assertEquals(a.tx, out.tx, eps); assertEquals(a.zoom, out.zoom, eps)
        BoardMath.interpolate(a, b, 1.0, out)
        assertEquals(b.tx, out.tx, eps); assertEquals(b.ty, out.ty, eps); assertEquals(b.zoom, out.zoom, eps)
        val wx = a.worldX(300.0)
        BoardMath.interpolate(a, b, 0.4, out)
        assertEquals(300.0, out.screenX(wx), 1e-6)
        assertEquals(0.5 * Math.pow(2.0, 0.4), out.zoom, eps)
        // a pure pan interpolates linearly
        val c = Camera(110.0, 20.0, 0.5)
        BoardMath.interpolate(a, c, 0.5, out)
        assertEquals(60.0, out.tx, eps)
    }

    @Test fun doubleTapZoomsInThenFits() {
        val cam = BoardMath.fit(spec, vp, Camera())
        val t = BoardMath.doubleTapTarget(spec, vp, cam, 540.0, 1200.0, Camera())
        assertEquals(cam.zoom * 2, t.zoom, eps)
        val near = Camera(0.0, 0.0, 2.4)
        val back = BoardMath.doubleTapTarget(spec, vp, near, 540.0, 1200.0, Camera())
        assertEquals(cam.zoom, back.zoom, eps)
    }

    @Test fun hitsOpenSubBoards() {
        assertEquals("sub", spec.hitAt(150.0, 150.0))
        assertNull(spec.hitAt(50.0, 150.0))
    }

    private fun abs(x: Double) = kotlin.math.abs(x)
}
