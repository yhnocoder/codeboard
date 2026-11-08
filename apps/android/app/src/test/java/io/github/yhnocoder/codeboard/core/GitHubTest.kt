package io.github.yhnocoder.codeboard.core

import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class GitHubTest {
    @get:Rule val tmp = TemporaryFolder()
    private val server = FakeGitHub()
    private val gh = GitHub("secret-token", server.apiUrl)

    @After fun close() = server.close()

    @Test fun assetDownloadsFollowTheRedirectWithoutTheToken() {
        val body = ByteArray(700_000) { (it % 251).toByte() }
        server.releases["mobile-main"] = mutableMapOf("a-1.zip" to body)
        val asset = gh.releaseAssets("o/r", "mobile-main")!!.single()
        val target = File(tmp.root, "a-1.zip")
        val seenProgress = ArrayList<Long>()
        gh.downloadAsset("o/r", asset.id, target, asset.size, progress = { done, _ -> seenProgress.add(done) })
        assertArrayEquals(body, target.readBytes())
        assertEquals(body.size.toLong(), seenProgress.last())
        assertTrue(tmp.root.list()!!.none { it.endsWith(".part") })

        val toApi = server.seen.filter { it.server == "api" && it.path.contains("/releases/assets/") }.single()
        assertEquals("Bearer secret-token", toApi.auth)
        assertEquals("application/octet-stream", toApi.accept)
        val toStorage = server.seen.filter { it.server == "storage" }.single()
        assertNull("the storage host must not get the token", toStorage.auth)
        assertTrue(toStorage.path.contains("sig=abc"))
    }

    @Test fun originComparesSchemeHostAndPort() {
        val o = { s: String -> GitHub.origin(java.net.URL(s)) }
        assertEquals(o("https://api.github.com/repos"), o("https://API.github.com:443/x"))
        assertFalse(o("https://api.github.com/") == o("https://objects.githubusercontent.com/"))
        assertFalse(o("http://127.0.0.1:1/") == o("http://127.0.0.1:2/"))
    }

    @Test fun aReleaseThatIsNotThereIsNull() {
        assertNull(gh.releaseAssets("o/r", "mobile-nothing"))
    }

    @Test fun branchesArePaged() {
        server.branches = (1..230).map { "b$it" }
        val names = gh.branches("o/r")
        assertEquals(230, names.size)
        assertEquals("b230", names.last())
        assertEquals(3, server.seen.count { it.path.startsWith("/repos/o/r/branches") })
    }

    @Test fun repoValidationReportsTheStatus() {
        assertEquals("main", gh.repo("o/r").defaultBranch)
        try {
            GitHub("wrong", server.apiUrl).repo("o/r")
            fail()
        } catch (e: HttpError) {
            assertEquals(401, e.code)
        }
        server.repoStatus = 404
        try {
            gh.repo("o/r")
            fail()
        } catch (e: HttpError) {
            assertEquals(404, e.code)
        }
    }

    @Test fun offlineIsAnIOException() {
        val dead = GitHub("t", "http://127.0.0.1:1", timeoutMs = 2000)
        try {
            dead.repo("o/r")
            fail()
        } catch (e: HttpError) {
            fail("not an HTTP status")
        } catch (e: java.io.IOException) {
        }
    }

    @Test fun aCancelledDownloadLeavesNothing() {
        server.releases["mobile-main"] = mutableMapOf("a-1.zip" to ByteArray(2_000_000))
        val asset = gh.releaseAssets("o/r", "mobile-main")!!.single()
        val target = File(tmp.root, "a-1.zip")
        try {
            gh.downloadAsset("o/r", asset.id, target, asset.size, cancelled = { true })
            fail()
        } catch (e: Cancelled) {
        }
        assertFalse(target.exists())
        assertTrue(tmp.root.list()!!.isEmpty())
    }

    @Test fun tagsArePercentEncoded() {
        assertEquals("mobile-a-b_c.d~e", GitHub.encode("mobile-a-b_c.d~e"))
        assertEquals("mobile-%C3%A9t%C3%A9%2Bx", GitHub.encode("mobile-été+x"))
    }
}
