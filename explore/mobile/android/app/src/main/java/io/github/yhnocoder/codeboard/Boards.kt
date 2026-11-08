package io.github.yhnocoder.codeboard

import android.content.res.AssetManager
import android.graphics.Color
import android.util.Log
import io.github.yhnocoder.codeboard.core.BoardSpec
import io.github.yhnocoder.codeboard.core.Hit
import io.github.yhnocoder.codeboard.core.Level
import io.github.yhnocoder.codeboard.core.WorldRect
import org.json.JSONObject
import org.json.JSONArray

class BoardEntry(val id: String, val name: String, val cards: Int, val subs: List<String>)

/** What assets/boards/ holds: index.json and the manifest of every board that has one. */
class Library(val entries: List<BoardEntry>, val specs: Map<String, BoardSpec>) {
    private val byId = entries.associateBy { it.id }

    fun entry(id: String) = byId[id]

    /** The root: nobody's sub and has subs; else the first. */
    val root: String? = run {
        val subIds = entries.flatMap { it.subs }.toSet()
        (entries.firstOrNull { it.id !in subIds && it.subs.isNotEmpty() } ?: entries.firstOrNull())?.id
    }

    /** The boards in list order: the root and its subs depth first (with their depth), then the rest. */
    fun outline(): List<Pair<BoardEntry, Int>> {
        val out = ArrayList<Pair<BoardEntry, Int>>()
        val seen = HashSet<String>()
        fun walk(id: String, depth: Int) {
            val e = byId[id] ?: return
            if (!seen.add(id)) return
            out.add(e to depth)
            for (s in e.subs) walk(s, depth + 1)
        }
        root?.let { walk(it, 0) }
        for (e in entries) walk(e.id, 0)
        return out
    }

    companion object {
        private const val DIR = "boards"

        fun load(assets: AssetManager): Library {
            val index = JSONArray(read(assets, "$DIR/index.json"))
            val specs = HashMap<String, BoardSpec>()
            val entries = ArrayList<BoardEntry>()
            for (i in 0 until index.length()) {
                val o = index.getJSONObject(i)
                val id = o.getString("id")
                val spec = try {
                    parse(JSONObject(read(assets, "$DIR/$id/manifest.json")))
                } catch (e: Exception) {
                    Log.w("CodeBoard", "board $id has no usable manifest: $e")
                    continue
                }
                specs[id] = spec
                val subs = o.optJSONArray("subs")
                entries.add(
                    BoardEntry(
                        id, o.optString("name", spec.name), o.optInt("cards", 0),
                        if (subs == null) emptyList() else List(subs.length()) { subs.getString(it) },
                    ),
                )
            }
            // a sub that has no manifest is not listed under its parent
            val present = specs.keys
            return Library(entries.map { BoardEntry(it.id, it.name, it.cards, it.subs.filter { s -> s in present }) }, specs)
        }

        private fun read(assets: AssetManager, path: String) =
            assets.open(path).bufferedReader().use { it.readText() }

        private fun rect(o: JSONObject) =
            WorldRect(o.getDouble("x"), o.getDouble("y"), o.getDouble("w"), o.getDouble("h"))

        private fun parse(o: JSONObject): BoardSpec {
            val lv = o.getJSONArray("levels")
            val levels = List(lv.length()) {
                val l = lv.getJSONObject(it)
                Level(l.getDouble("z"), l.getInt("cols"), l.getInt("rows"))
            }
            // the folder names are the manifest's level indices, so the order is kept as written (descending z)
            require(levels.isNotEmpty()) { "no levels" }
            require(levels.zipWithNext().all { (a, b) -> a.z > b.z }) { "levels not in descending z" }
            val hits = o.optJSONArray("hits")
            val bg = try {
                Color.parseColor(o.optString("bg", "#efebe4"))
            } catch (e: IllegalArgumentException) {
                Color.parseColor("#efebe4")
            }
            return BoardSpec(
                id = o.getString("id"),
                name = o.optString("name", o.getString("id")),
                world = rect(o.getJSONObject("world")),
                tile = o.optInt("tile", 512),
                dpr = o.optDouble("dpr", 2.0),
                levels = levels,
                bg = bg,
                hits = if (hits == null) emptyList() else List(hits.length()) {
                    val h = hits.getJSONObject(it)
                    Hit(rect(h.getJSONObject("rect")), h.getString("board"))
                },
            )
        }
    }
}
