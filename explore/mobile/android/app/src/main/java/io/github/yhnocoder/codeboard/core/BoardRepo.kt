package io.github.yhnocoder.codeboard.core

import java.io.File

/**
 * One repository's phone data on disk, and keeping it in step with the releases:
 *
 *     <dir>/index/<tag>.json   the last index.json seen for each branch (works offline)
 *     <dir>/zips/<asset>       board zips by asset name, shared by every branch
 *
 * Blocking: call it off the main thread. One instance per repository; the methods are synchronized
 * where they touch the files.
 */
class BoardRepo(val dir: File, val repo: String, val gh: GitHub) {
    sealed class Refresh {
        class Updated(val index: RemoteIndex) : Refresh()
        object Unchanged : Refresh()
        object NoRelease : Refresh()
    }

    private val indexDir = File(dir, "index").apply { mkdirs() }
    val zipDir = File(dir, "zips").apply {
        mkdirs()
        // downloads cut short by the app being killed
        listFiles { f -> f.name.endsWith(".part") }?.forEach { it.delete() }
    }

    /** The assets of each branch's release as last fetched (by tag), to find a zip's asset id. */
    private val assets = HashMap<String, Map<String, ReleaseAsset>>()

    private fun indexFile(branch: String) = File(indexDir, Remote.tag(branch) + ".json")

    @Synchronized
    fun cachedIndex(branch: String): RemoteIndex? {
        val f = indexFile(branch)
        if (!f.exists()) return null
        return try {
            RemoteIndex.parse(f.readText())
        } catch (e: Exception) {
            null
        }
    }

    /** Fetches the branch's release and its index.json; saves it and drops zips nothing uses when it changed. */
    fun refresh(branch: String): Refresh {
        val tag = Remote.tag(branch)
        val list = gh.releaseAssets(repo, tag)
        if (list == null) {
            synchronized(this) {
                assets.remove(tag)
                indexFile(branch).delete()
                cleanup()
            }
            return Refresh.NoRelease
        }
        val byName = list.associateBy { it.name }
        synchronized(this) { assets[tag] = byName }
        val idx = byName["index.json"] ?: return Refresh.NoRelease
        val text = gh.assetText(repo, idx.id)
        val parsed = RemoteIndex.parse(text)
        synchronized(this) {
            val f = indexFile(branch)
            if (f.exists() && f.readText() == text) return Refresh.Unchanged
            val tmp = File(f.path + ".tmp")
            tmp.writeText(text)
            tmp.renameTo(f)
            cleanup()
        }
        return Refresh.Updated(parsed)
    }

    fun zip(board: RemoteBoard): File? = File(zipDir, board.asset).takeIf { it.exists() }

    @Synchronized
    fun presentZips(): Set<String> = zipDir.list()?.filter { it.endsWith(".zip") }?.toSet() ?: emptySet()

    /** Downloads a board's zip unless it is there already; returns the file. */
    fun download(
        branch: String, board: RemoteBoard,
        progress: (Long, Long) -> Unit = { _, _ -> }, cancelled: () -> Boolean = { false },
    ): File {
        zip(board)?.let { return it }
        val tag = Remote.tag(branch)
        var asset = synchronized(this) { assets[tag]?.get(board.asset) }
        if (asset == null) {
            val list = gh.releaseAssets(repo, tag) ?: throw StaleIndex("no release $tag")
            synchronized(this) { assets[tag] = list.associateBy { it.name } }
            asset = list.firstOrNull { it.name == board.asset }
                ?: throw StaleIndex("${board.asset} is not in release $tag")
        }
        val target = File(zipDir, board.asset)
        gh.downloadAsset(repo, asset.id, target, if (asset.size > 0) asset.size else board.size, progress, cancelled)
        return target
    }

    /** Deletes the zips no kept index refers to. */
    @Synchronized
    fun cleanup(): List<String> {
        val indexes = indexDir.listFiles { f -> f.name.endsWith(".json") }.orEmpty().mapNotNull {
            try {
                RemoteIndex.parse(it.readText())
            } catch (e: Exception) {
                null
            }
        }
        val gone = Remote.unusedZips(presentZips(), indexes)
        // an open zip stays readable after it is unlinked, so a board on screen keeps working
        for (name in gone) File(zipDir, name).delete()
        return gone
    }

    companion object {
        /** The folder for a repository under the app's files. */
        fun folder(root: File, repo: String) = File(root, "repos/" + GitHub.encode(repo.lowercase()))
    }
}
