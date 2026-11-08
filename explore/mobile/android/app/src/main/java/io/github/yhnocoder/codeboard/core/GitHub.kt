package io.github.yhnocoder.codeboard.core

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/** An HTTP status that is not success; `code` is the status. */
class HttpError(val code: Int, message: String) : IOException(message)

/** The release no longer has what the saved index names (the branch was rebuilt since). */
class StaleIndex(message: String) : IOException(message)

/** Downloading stopped because the caller asked. */
class Cancelled : IOException("cancelled")

class RepoInfo(val fullName: String, val defaultBranch: String)

class ReleaseAsset(val id: Long, val name: String, val size: Long)

/**
 * The few GitHub REST calls the app makes, on HttpURLConnection. Redirects are followed here, not by
 * HttpURLConnection: a release asset redirects to a signed storage URL on another host, which must not get
 * the token.
 */
class GitHub(
    private val token: String,
    private val api: String = "https://api.github.com",
    private val timeoutMs: Int = 20_000,
) {
    fun repo(repo: String): RepoInfo {
        val o = JSONObject(text("/repos/$repo"))
        return RepoInfo(o.optString("full_name", repo), o.optString("default_branch", "main"))
    }

    fun branches(repo: String): List<String> {
        val out = ArrayList<String>()
        var page = 1
        while (true) {
            val a = JSONArray(text("/repos/$repo/branches?per_page=100&page=$page"))
            for (i in 0 until a.length()) out.add(a.getJSONObject(i).getString("name"))
            if (a.length() < 100 || page >= 50) break
            page++
        }
        return out
    }

    /** The assets of the release with this tag; null when there is no such release. */
    fun releaseAssets(repo: String, tag: String): List<ReleaseAsset>? {
        val body = try {
            text("/repos/$repo/releases/tags/${encode(tag)}")
        } catch (e: HttpError) {
            if (e.code == 404) return null
            throw e
        }
        val a = JSONObject(body).optJSONArray("assets") ?: return emptyList()
        return List(a.length()) {
            val o = a.getJSONObject(it)
            ReleaseAsset(o.getLong("id"), o.getString("name"), o.optLong("size", 0))
        }
    }

    fun assetText(repo: String, id: Long): String =
        open("$api/repos/$repo/releases/assets/$id", OCTET).use { it.readBytes().toString(Charsets.UTF_8) }

    /**
     * Downloads a release asset into `target` (through a `.part` file of its own, renamed when complete), telling
     * `progress(done, total)` as it goes; `cancelled()` is asked between chunks.
     */
    fun downloadAsset(
        repo: String, id: Long, target: File, total: Long,
        progress: (Long, Long) -> Unit = { _, _ -> }, cancelled: () -> Boolean = { false },
    ) {
        val part = File.createTempFile(target.name + "-", ".part", target.parentFile)
        try {
            open("$api/repos/$repo/releases/assets/$id", OCTET).use { input ->
                part.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    var done = 0L
                    var last = 0L
                    while (true) {
                        if (cancelled()) throw Cancelled()
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        done += n
                        if (done - last >= 256 * 1024) {
                            last = done
                            progress(done, total)
                        }
                    }
                    progress(done, total)
                }
            }
            if (!part.renameTo(target)) throw IOException("could not move ${part.name} into place")
        } finally {
            part.delete()
        }
    }

    private fun text(path: String) = open(api + path, JSON).use { it.readBytes().toString(Charsets.UTF_8) }

    /** GET with the token, following redirects by hand; the token goes only to the API's own origin. */
    fun open(url: String, accept: String): InputStream {
        var u = URL(url)
        val origin = origin(URL(api))
        repeat(MAX_REDIRECTS) {
            val c = u.openConnection() as HttpURLConnection
            c.instanceFollowRedirects = false
            c.connectTimeout = timeoutMs
            c.readTimeout = timeoutMs
            c.setRequestProperty("Accept", accept)
            c.setRequestProperty("User-Agent", "CodeBoard-Android")
            if (origin(u) == origin) {
                c.setRequestProperty("Authorization", "Bearer $token")
                c.setRequestProperty("X-GitHub-Api-Version", "2022-11-28")
            }
            val code = c.responseCode
            when {
                code in 200..299 -> return c.inputStream
                code in 300..399 -> {
                    val loc = c.getHeaderField("Location") ?: throw HttpError(code, "redirect without a location")
                    c.disconnect()
                    u = URL(u, loc)
                }
                else -> {
                    val msg = try {
                        c.errorStream?.use { it.readBytes().toString(Charsets.UTF_8) }.orEmpty()
                    } catch (e: IOException) {
                        ""
                    }
                    c.disconnect()
                    throw HttpError(code, "HTTP $code from ${u.host}: ${msg.take(200)}")
                }
            }
        }
        throw IOException("too many redirects")
    }

    companion object {
        const val JSON = "application/vnd.github+json"
        const val OCTET = "application/octet-stream"
        private const val MAX_REDIRECTS = 6

        fun origin(u: URL) = u.protocol.lowercase() + "://" + u.host.lowercase() + ":" + (if (u.port == -1) u.defaultPort else u.port)

        /** Percent-encodes a path segment (a tag can hold characters a branch name may have). */
        fun encode(s: String): String {
            val sb = StringBuilder()
            for (b in s.toByteArray(Charsets.UTF_8)) {
                val c = b.toInt() and 0xff
                if (c.toChar().isLetterOrDigit() && c < 128 || c.toChar() in "-._~") sb.append(c.toChar())
                else sb.append('%').append("%02X".format(c))
            }
            return sb.toString()
        }
    }
}
