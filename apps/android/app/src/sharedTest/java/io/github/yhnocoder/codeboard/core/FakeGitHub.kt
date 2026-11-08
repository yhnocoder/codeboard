package io.github.yhnocoder.codeboard.core

import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * A local stand-in for api.github.com and the storage host its asset downloads redirect to: two servers on
 * two ports, so they are different origins. Records every request with its Authorization header.
 */
class FakeGitHub(private val token: String = "secret-token") : AutoCloseable {
    class Seen(val server: String, val path: String, val auth: String?, val accept: String?)

    val seen = CopyOnWriteArrayList<Seen>()
    private val api = MockWebServer()
    private val storage = MockWebServer()
    val apiUrl get() = "http://127.0.0.1:${api.port}"
    private val storageUrl get() = "http://127.0.0.1:${storage.port}"

    /** Releases by tag: asset name -> bytes. */
    val releases = ConcurrentHashMap<String, MutableMap<String, ByteArray>>()
    @Volatile var branches: List<String> = listOf("main")
    @Volatile var repoStatus = 200
    private val ids = ConcurrentHashMap<Long, ByteArray>()
    private val names = ConcurrentHashMap<String, Long>()

    init {
        api.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = handleApi(request)
        }
        storage.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                record("storage", request)
                val id = request.requestUrl!!.encodedPath.removePrefix("/blob/").toLong()
                val body = ids[id] ?: return send(404, "missing")
                return send(200, body)
            }
        }
        api.start(InetAddress.getByName("127.0.0.1"), 0)
        storage.start(InetAddress.getByName("127.0.0.1"), 0)
    }

    private fun record(server: String, r: RecordedRequest) {
        seen.add(Seen(server, r.path!!, r.getHeader("Authorization"), r.getHeader("Accept")))
    }

    @Synchronized
    private fun idFor(tag: String, name: String, body: ByteArray): Long {
        val id = names.getOrPut("$tag/$name/${body.contentHashCode()}") { (names.size + 1).toLong() }
        ids[id] = body
        return id
    }

    private fun handleApi(r: RecordedRequest): MockResponse {
        record("api", r)
        if (r.getHeader("Authorization") != "Bearer $token") return send(401, """{"message":"Bad credentials"}""")
        val url = r.requestUrl!!
        val path = url.encodedPath
        return when {
            path == "/repos/o/r" ->
                if (repoStatus != 200) send(repoStatus, """{"message":"Not Found"}""")
                else send(200, """{"full_name":"o/r","default_branch":"main"}""")
            path == "/repos/o/r/branches" -> {
                val page = url.queryParameter("page")!!.toInt()
                val per = url.queryParameter("per_page")!!.toInt()
                val slice = branches.drop((page - 1) * per).take(per)
                send(200, slice.joinToString(",", "[", "]") { """{"name":"$it"}""" })
            }
            path.startsWith("/repos/o/r/releases/tags/") -> {
                val tag = java.net.URLDecoder.decode(path.removePrefix("/repos/o/r/releases/tags/"), "UTF-8")
                val rel = releases[tag] ?: return send(404, """{"message":"Not Found"}""")
                val assets = rel.entries.joinToString(",", "[", "]") { (name, body) ->
                    """{"id":${idFor(tag, name, body)},"name":"$name","size":${body.size}}"""
                }
                send(200, """{"tag_name":"$tag","assets":$assets}""")
            }
            path.startsWith("/repos/o/r/releases/assets/") -> {
                val id = path.substringAfterLast('/').toLong()
                if (r.getHeader("Accept") != "application/octet-stream") return send(415, "accept")
                if (!ids.containsKey(id)) return send(404, "{}")
                MockResponse().setResponseCode(302).setHeader("Location", "$storageUrl/blob/$id?sig=abc")
            }
            else -> send(404, """{"message":"Not Found"}""")
        }
    }

    private fun send(code: Int, body: String) = send(code, body.toByteArray())

    private fun send(code: Int, body: ByteArray) = MockResponse().setResponseCode(code).setBody(Buffer().write(body))

    override fun close() {
        api.shutdown()
        storage.shutdown()
    }

    companion object {
        /** A board zip as the release has it: stored entries, a manifest and the given tiles. */
        fun boardZip(id: String, tiles: Map<String, ByteArray> = mapOf("0/0_0.webp" to byteArrayOf(1, 2, 3))): ByteArray {
            val manifest = """{"id":"$id","name":"Board $id","world":{"x":0,"y":0,"w":1000,"h":800},"tile":512,"dpr":2,
                "levels":[{"z":0.25,"cols":1,"rows":1},{"z":0.125,"cols":1,"rows":1}],"bg":"#eeece6",
                "hits":[{"rect":{"x":10,"y":10,"w":100,"h":50},"board":"sub"}]}"""
            val out = ByteArrayOutputStream()
            ZipOutputStream(out).use { z ->
                for ((name, body) in mapOf("manifest.json" to manifest.toByteArray()) + tiles) {
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

        fun index(branch: String, vararg boards: Pair<String, String>, commit: String = "0123456789abcdef"): String =
            """{"branch":"$branch","commit":"$commit","codeboard":"c0ffee","built":"2026-11-08T10:00:00Z","boards":[""" +
                boards.joinToString(",") { (id, hash) ->
                    """{"id":"$id","name":"Board $id","cards":3,"hash":"$hash","asset":"$id-$hash.zip","size":100}"""
                } + "]}"
    }
}
