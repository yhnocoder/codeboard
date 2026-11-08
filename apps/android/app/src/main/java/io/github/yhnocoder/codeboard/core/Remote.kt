package io.github.yhnocoder.codeboard.core

import org.json.JSONArray
import org.json.JSONObject
import java.time.Duration
import java.time.Instant

// What a branch's release holds, and how it is named. Plain Kotlin (org.json is on Android and in the tests).

class RemoteBoard(
    val id: String,
    val name: String,
    val cards: Int,
    val subs: List<String>,
    val hash: String,
    /** The zip's asset name, `<id>-<hash>.zip`: the same content has the same name on every branch. */
    val asset: String,
    val size: Long,
)

class RemoteIndex(
    val branch: String,
    val commit: String,
    val codeboard: String,
    val built: String,
    val boards: List<RemoteBoard>,
) {
    private val byId = boards.associateBy { it.id }

    fun board(id: String) = byId[id]

    /** The root: nobody's sub and has subs; else the first. */
    val root: String? = run {
        val subIds = boards.flatMap { it.subs }.toSet()
        (boards.firstOrNull { it.id !in subIds && it.subs.isNotEmpty() } ?: boards.firstOrNull())?.id
    }

    /** The boards in list order: the root and its subs depth first (with their depth), then the rest. */
    fun outline(): List<Pair<RemoteBoard, Int>> {
        val out = ArrayList<Pair<RemoteBoard, Int>>()
        val seen = HashSet<String>()
        fun walk(id: String, depth: Int) {
            val b = byId[id] ?: return
            if (!seen.add(id)) return
            out.add(b to depth)
            for (s in b.subs) walk(s, depth + 1)
        }
        root?.let { walk(it, 0) }
        for (b in boards) walk(b.id, 0)
        return out
    }

    companion object {
        fun parse(text: String): RemoteIndex {
            val o = JSONObject(text)
            val list = o.getJSONArray("boards")
            val boards = List(list.length()) {
                val b = list.getJSONObject(it)
                val id = b.getString("id")
                val hash = b.optString("hash", "")
                RemoteBoard(
                    id = id,
                    name = b.optString("name", id),
                    cards = b.optInt("cards", 0),
                    subs = strings(b.optJSONArray("subs")),
                    hash = hash,
                    asset = b.optString("asset", "$id-$hash.zip"),
                    size = b.optLong("size", 0),
                )
            }
            return RemoteIndex(
                branch = o.optString("branch", ""),
                commit = o.optString("commit", ""),
                codeboard = o.optString("codeboard", ""),
                built = o.optString("built", ""),
                boards = boards,
            )
        }
    }
}

private fun strings(a: JSONArray?) = if (a == null) emptyList() else List(a.length()) { a.getString(it) }

object Remote {
    /** The release a branch's phone data is published as: every "/" of the branch name becomes "-". */
    fun tag(branch: String) = "mobile-" + branch.replace('/', '-')

    /** The zips in the cache that no kept index refers to any more (half-downloaded `.part` files are left alone). */
    fun unusedZips(present: Collection<String>, indexes: Collection<RemoteIndex>): List<String> {
        val used = HashSet<String>()
        for (i in indexes) for (b in i.boards) used.add(b.asset)
        return present.filter { it.endsWith(".zip") && it !in used }.sorted()
    }

    /** The boards of an index whose zip is not in the cache yet. */
    fun missing(index: RemoteIndex, present: Set<String>) = index.boards.filter { it.asset !in present }

    /** "built 5 min ago" and the like; the ISO time as is when it cannot be read. */
    fun ago(iso: String, now: Instant = Instant.now()): String {
        val t = try {
            Instant.parse(iso)
        } catch (e: Exception) {
            return iso
        }
        val s = Duration.between(t, now).seconds
        return when {
            s < 60 -> "just now"
            s < 3600 -> "${s / 60} min ago"
            s < 86400 -> "${s / 3600} h ago"
            s < 86400 * 60 -> "${s / 86400} d ago"
            else -> iso.take(10)
        }
    }

    /** "#rrggbb" or "#aarrggbb" as an ARGB int. */
    fun color(hex: String, fallback: Int): Int {
        val h = hex.trim().removePrefix("#")
        val v = h.toLongOrNull(16) ?: return fallback
        return when (h.length) {
            6 -> (0xFF000000 or v).toInt()
            8 -> v.toInt()
            else -> fallback
        }
    }

    /** A board's manifest.json. */
    fun manifest(text: String): BoardSpec {
        val o = JSONObject(text)
        val lv = o.getJSONArray("levels")
        val levels = List(lv.length()) {
            val l = lv.getJSONObject(it)
            Level(l.getDouble("z"), l.getInt("cols"), l.getInt("rows"))
        }
        // the folder names are the manifest's level indices, so the order is kept as written (descending z)
        require(levels.isNotEmpty()) { "no levels" }
        require(levels.zipWithNext().all { (a, b) -> a.z > b.z }) { "levels not in descending z" }
        val hits = o.optJSONArray("hits")
        return BoardSpec(
            id = o.getString("id"),
            name = o.optString("name", o.getString("id")),
            world = rect(o.getJSONObject("world")),
            tile = o.optInt("tile", 512),
            dpr = o.optDouble("dpr", 2.0),
            levels = levels,
            bg = color(o.optString("bg", ""), PAPER),
            hits = if (hits == null) emptyList() else List(hits.length()) {
                val h = hits.getJSONObject(it)
                Hit(rect(h.getJSONObject("rect")), h.getString("board"))
            },
        )
    }

    const val PAPER = 0xFFEFEBE4.toInt()

    private fun rect(o: JSONObject) = WorldRect(o.getDouble("x"), o.getDouble("y"), o.getDouble("w"), o.getDouble("h"))
}
