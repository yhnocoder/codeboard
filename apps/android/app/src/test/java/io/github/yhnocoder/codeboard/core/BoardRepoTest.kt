package io.github.yhnocoder.codeboard.core

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.zip.ZipFile

class BoardRepoTest {
    @get:Rule val tmp = TemporaryFolder()
    private val server = FakeGitHub()
    private fun repo() = BoardRepo(BoardRepo.folder(tmp.root, "o/r"), "o/r", GitHub("secret-token", server.apiUrl))

    @After fun close() = server.close()

    private fun publish(branch: String, vararg boards: Pair<String, String>) {
        val assets = mutableMapOf("index.json" to FakeGitHub.index(branch, *boards).toByteArray())
        for ((id, hash) in boards) assets["$id-$hash.zip"] = FakeGitHub.boardZip(id)
        server.releases[Remote.tag(branch)] = assets
    }

    @Test fun refreshSavesTheIndexAndReportsChanges() {
        publish("feat/x", "a" to "1")
        val r = repo()
        assertNull(r.cachedIndex("feat/x"))
        val first = r.refresh("feat/x")
        assertTrue(first is BoardRepo.Refresh.Updated)
        assertTrue(File(r.dir, "index/mobile-feat-x.json").exists())
        assertEquals(BoardRepo.Refresh.Unchanged, r.refresh("feat/x"))
        // a fresh instance (next start, offline) has it at once
        assertEquals("a", repo().cachedIndex("feat/x")!!.root)
        assertEquals(BoardRepo.Refresh.NoRelease, r.refresh("nothing-yet"))
    }

    @Test fun boardZipsDownloadOnceAndOpenAsZips() {
        publish("main", "a" to "1")
        val r = repo()
        val idx = (r.refresh("main") as BoardRepo.Refresh.Updated).index
        val a = idx.board("a")!!
        assertNull(r.zip(a))
        val f = r.download("main", a)
        assertEquals("a-1.zip", f.name)
        ZipFile(f).use { z ->
            val spec = Remote.manifest(z.getInputStream(z.getEntry("manifest.json")).readBytes().toString(Charsets.UTF_8))
            assertEquals("a", spec.id)
            assertNotNull(z.getEntry("0/0_0.webp"))
            assertNull(z.getEntry("0/9_9.webp")) // a missing tile: plain background
        }
        val downloads = server.seen.count { it.server == "storage" }
        r.download("main", a)
        assertEquals("cached zips are not downloaded again", downloads, server.seen.count { it.server == "storage" })
    }

    @Test fun zipsAreSharedAcrossBranchesAndDeletedWhenNoIndexUsesThem() {
        publish("main", "a" to "1", "b" to "1")
        publish("dev", "a" to "1", "b" to "2")
        val r = repo()
        val main = (r.refresh("main") as BoardRepo.Refresh.Updated).index
        val dev = (r.refresh("dev") as BoardRepo.Refresh.Updated).index
        for (b in main.boards) r.download("main", b)
        r.download("dev", dev.board("b")!!)
        // dev's a is main's a: already there
        assertNotNull(r.zip(dev.board("a")!!))
        assertEquals(setOf("a-1.zip", "b-1.zip", "b-2.zip"), r.presentZips())

        // main moves on: b-1 is no longer used by any index, a-1 still is (dev)
        publish("main", "a" to "1", "b" to "3")
        assertTrue(r.refresh("main") is BoardRepo.Refresh.Updated)
        assertEquals(setOf("a-1.zip", "b-2.zip"), r.presentZips())

        // dev's release is gone: its index goes, and with it b-2
        server.releases.remove("mobile-dev")
        assertEquals(BoardRepo.Refresh.NoRelease, r.refresh("dev"))
        assertNull(r.cachedIndex("dev"))
        assertEquals(setOf("a-1.zip"), r.presentZips())
    }

    @Test fun aBoardTheReleaseNoLongerHasIsAStaleIndex() {
        publish("main", "a" to "1")
        val r = repo()
        val idx = (r.refresh("main") as BoardRepo.Refresh.Updated).index
        publish("main", "a" to "2") // rebuilt; this instance still knows the old asset list
        BoardRepo(r.dir, "o/r", GitHub("secret-token", server.apiUrl)).let { fresh ->
            try {
                fresh.download("main", idx.board("a")!!)
                org.junit.Assert.fail()
            } catch (e: StaleIndex) {
            }
        }
    }

    @Test fun leftoverPartFilesGoAtStart() {
        val dir = File(BoardRepo.folder(tmp.root, "o/r"), "zips").apply { mkdirs() }
        File(dir, "a-1.zip-77.part").writeText("half")
        repo()
        assertTrue(dir.list()!!.isEmpty())
    }

    @Test fun repositoriesHaveSeparateFolders() {
        assertTrue(BoardRepo.folder(tmp.root, "a_b/c") != BoardRepo.folder(tmp.root, "a/b_c"))
        assertEquals(BoardRepo.folder(tmp.root, "Owner/Name"), BoardRepo.folder(tmp.root, "owner/name"))
    }

    /** A release as the board repo's Action makes it, when SAMPLE_RELEASE names a folder of its assets. */
    @Test fun aRealReleaseParses() {
        val path = System.getenv("SAMPLE_RELEASE")
        assumeTrue(path != null && File(path, "index.json").exists())
        val dir = File(path!!)
        val idx = RemoteIndex.parse(File(dir, "index.json").readText())
        assertTrue(idx.boards.isNotEmpty())
        assertNotNull(idx.root)
        for (b in idx.boards) {
            val f = File(dir, b.asset)
            if (!f.exists()) continue
            assertEquals(b.size, f.length())
            ZipFile(f).use { z ->
                val spec = Remote.manifest(z.getInputStream(z.getEntry("manifest.json")).readBytes().toString(Charsets.UTF_8))
                assertEquals(b.id, spec.id)
                for (e in z.entries()) {
                    if (e.name.endsWith(".webp")) assertEquals("tiles are stored, not compressed", java.util.zip.ZipEntry.STORED, e.method)
                }
                for (h in spec.hits) assertNotNull("hit to ${h.board} is a board of the index", idx.board(h.board))
            }
        }
    }
}
