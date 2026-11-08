package io.github.yhnocoder.codeboard

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKeys
import io.github.yhnocoder.codeboard.core.HttpError
import io.github.yhnocoder.codeboard.core.StaleIndex
import java.io.IOException

/** The repository, its token (encrypted at rest when the device allows) and the last branch per repository. */
class Settings(context: Context) {
    private val plain: SharedPreferences = context.getSharedPreferences("settings", Context.MODE_PRIVATE)
    private val secret: SharedPreferences = try {
        EncryptedSharedPreferences.create(
            "secret",
            MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC),
            context,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    } catch (e: Exception) {
        // a broken keystore on some devices: the app's private preferences instead
        Log.w("CodeBoard", "encrypted preferences unavailable: $e")
        context.getSharedPreferences("secret-plain", Context.MODE_PRIVATE)
    }

    /** owner/name; none until the person types one */
    var repo: String?
        get() = plain.getString("repo", null)
        set(v) = plain.edit().putString("repo", v).apply()

    var token: String?
        get() = secret.getString("token", null)
        set(v) = secret.edit().putString("token", v).apply()

    fun branch(repo: String): String? = plain.getString("branch:" + repo.lowercase(), null)
    fun setBranch(repo: String, branch: String) = plain.edit().putString("branch:" + repo.lowercase(), branch).apply()

    companion object {
        private val REPO = Regex("^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$")

        fun validRepo(s: String) = REPO.matches(s)

        /** What went wrong talking to GitHub, for a person. */
        fun explain(e: Throwable, repo: String): String = when {
            e is StaleIndex -> "The branch was rebuilt since this list was loaded. Refresh and try again."
            e is HttpError && e.code == 401 -> "GitHub rejected the token (expired, revoked or mistyped)."
            e is HttpError && (e.code == 403 || e.code == 404) ->
                "No access to $repo. Check the name, and that the token can read this repository's contents."
            e is HttpError -> "GitHub answered ${e.code}. Try again later."
            e is IOException -> "Can't reach GitHub. Check the connection."
            else -> "Something went wrong: ${e.message ?: e.javaClass.simpleName}"
        }
    }
}
