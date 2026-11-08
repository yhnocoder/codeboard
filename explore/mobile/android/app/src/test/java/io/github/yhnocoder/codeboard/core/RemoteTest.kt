package io.github.yhnocoder.codeboard.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant

class RemoteTest {
    @Test fun tagReplacesEverySlash() {
        assertEquals("mobile-main", Remote.tag("main"))
        assertEquals("mobile-feature-phone-tiles", Remote.tag("feature/phone/tiles"))
        assertEquals("mobile-a-b-c", Remote.tag("a-b/c"))
    }

    @Test fun indexIsParsedWithItsBoardsAndOutline() {
        val idx = RemoteIndex.parse(
            """{"branch":"feat/x","commit":"abc123def","codeboard":"c0","built":"2026-11-08T10:00:00Z","boards":[
              {"id":"s1","name":"Sub one","cards":4,"hash":"h1","asset":"s1-h1.zip","size":2048},
              {"id":"r","name":"Root","cards":9,"subs":["s1","s2","gone"],"hash":"h0","asset":"r-h0.zip","size":4096},
              {"id":"s2","name":"Sub two","cards":2,"subs":["s3"],"hash":"h2","asset":"s2-h2.zip","size":10},
              {"id":"s3","name":"Deep","cards":1,"hash":"h3","asset":"s3-h3.zip","size":10},
              {"id":"lone","name":"Lone","cards":1,"hash":"h4","asset":"lone-h4.zip","size":10}
            ]}""",
        )
        assertEquals("feat/x", idx.branch)
        assertEquals("abc123def", idx.commit)
        assertEquals("2026-11-08T10:00:00Z", idx.built)
        assertEquals(5, idx.boards.size)
        assertEquals("r", idx.root)
        val b = idx.board("s1")!!
        assertEquals("s1-h1.zip", b.asset)
        assertEquals(2048L, b.size)
        assertEquals(listOf("s1", "s2", "gone"), idx.board("r")!!.subs)
        assertEquals(
            listOf("r" to 0, "s1" to 1, "s2" to 1, "s3" to 2, "lone" to 0),
            idx.outline().map { it.first.id to it.second },
        )
        assertNull(idx.board("gone"))
    }

    @Test fun rootFallsBackToTheFirstBoard() {
        val idx = RemoteIndex.parse("""{"boards":[{"id":"a","hash":"1"},{"id":"b","hash":"2"}]}""")
        assertEquals("a", idx.root)
        assertEquals("a-1.zip", idx.board("a")!!.asset) // asset name from id and hash when absent
        assertNull(RemoteIndex.parse("""{"boards":[]}""").root)
    }

    @Test fun unusedZipsAreThoseNoIndexRefersTo() {
        val main = RemoteIndex.parse(FakeGitHub.index("main", "a" to "1", "b" to "1"))
        val dev = RemoteIndex.parse(FakeGitHub.index("dev", "a" to "1", "b" to "2"))
        val present = listOf("a-1.zip", "b-1.zip", "b-2.zip", "b-0.zip", "c-9.zip", "a-1.zip-123.part", "notes.txt")
        assertEquals(listOf("b-0.zip", "c-9.zip"), Remote.unusedZips(present, listOf(main, dev)))
        // when dev's index goes, its zip of b goes too; a zip both used stays
        assertEquals(listOf("b-0.zip", "b-2.zip", "c-9.zip"), Remote.unusedZips(present, listOf(main)))
        assertEquals(listOf("a-1.zip", "b-0.zip", "b-1.zip", "b-2.zip", "c-9.zip"), Remote.unusedZips(present, emptyList()))
    }

    @Test fun missingBoardsAreThoseWithoutTheirZip() {
        val idx = RemoteIndex.parse(FakeGitHub.index("main", "a" to "1", "b" to "2"))
        assertEquals(listOf("b"), Remote.missing(idx, setOf("a-1.zip", "b-1.zip")).map { it.id })
    }

    @Test fun builtTimeReadsAsHowLongAgo() {
        val now = Instant.parse("2026-11-08T12:00:00Z")
        assertEquals("just now", Remote.ago("2026-11-08T11:59:30Z", now))
        assertEquals("5 min ago", Remote.ago("2026-11-08T11:55:00Z", now))
        assertEquals("2 h ago", Remote.ago("2026-11-08T10:00:00Z", now))
        assertEquals("3 d ago", Remote.ago("2026-11-05T12:00:00Z", now))
        assertEquals("not a time", Remote.ago("not a time", now))
    }

    @Test fun manifestAndColoursParse() {
        val spec = Remote.manifest(
            """{"id":"b","name":"B","world":{"x":-80,"y":-60,"w":4200,"h":6100},"tile":512,"dpr":2,
              "levels":[{"z":1,"cols":17,"rows":24},{"z":0.5,"cols":9,"rows":12}],"bg":"#efebe4",
              "hits":[{"rect":{"x":1,"y":2,"w":3,"h":4},"board":"sub"}]}""",
        )
        assertEquals(-80.0, spec.world.x, 0.0)
        assertEquals(2, spec.levels.size)
        assertEquals(0xFFEFEBE4.toInt(), spec.bg)
        assertEquals("sub", spec.hitAt(2.0, 3.0))
        assertEquals(0x80112233.toInt(), Remote.color("#80112233", 0))
        assertEquals(7, Remote.color("nope", 7))
    }
}
