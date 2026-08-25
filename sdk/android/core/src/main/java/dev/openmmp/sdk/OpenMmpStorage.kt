package dev.openmmp.sdk

import android.content.Context
import android.content.SharedPreferences
import java.util.UUID

internal class OpenMmpStorage(context: Context) {
  private val preferences: SharedPreferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

  fun installationId(): String = preferences.getString(KEY_INSTALLATION_ID, null)
    ?: "installation:${UUID.randomUUID()}".also { preferences.edit().putString(KEY_INSTALLATION_ID, it).commit() }

  fun replaceInstallationId(): String = "installation:${UUID.randomUUID()}".also {
    preferences.edit().putString(KEY_INSTALLATION_ID, it).commit()
  }

  fun collectionEnabled(defaultValue: Boolean): Boolean =
    preferences.getBoolean(KEY_COLLECTION_ENABLED, defaultValue)

  fun setCollectionEnabled(enabled: Boolean) {
    preferences.edit().putBoolean(KEY_COLLECTION_ENABLED, enabled).commit()
  }

  fun referrerConsumed(): Boolean = preferences.getBoolean(KEY_REFERRER_CONSUMED, false)
  fun markReferrerConsumed() { preferences.edit().putBoolean(KEY_REFERRER_CONSUMED, true).commit() }

  fun nextSequence(): Long {
    val next = preferences.getLong(KEY_SEQUENCE, 0L) + 1L
    preferences.edit().putLong(KEY_SEQUENCE, next).commit()
    return next
  }

  fun credential(): InstallationCredential? {
    val id = preferences.getString(KEY_INSTALLATION_KEY_ID, null) ?: return null
    val secret = preferences.getString(KEY_INSTALLATION_SECRET, null) ?: return null
    return InstallationCredential(id, secret)
  }

  fun setCredential(value: InstallationCredential?) {
    val edit = preferences.edit()
    if (value == null) edit.remove(KEY_INSTALLATION_KEY_ID).remove(KEY_INSTALLATION_SECRET)
    else edit.putString(KEY_INSTALLATION_KEY_ID, value.keyId).putString(KEY_INSTALLATION_SECRET, value.secret)
    edit.commit()
  }

  fun persistConfiguration(configuration: OpenMmpConfiguration) {
    preferences.edit()
      .putString(KEY_ENDPOINT, configuration.endpoint)
      .putString(KEY_SDK_KEY_ID, configuration.sdkKeyId)
      .putString(KEY_SDK_SECRET, configuration.sdkSecret)
      .putString(KEY_SDK_VERSION, configuration.sdkVersion)
      .commit()
  }

  fun configuration(): OpenMmpConfiguration? {
    val endpoint = preferences.getString(KEY_ENDPOINT, null) ?: return null
    val keyId = preferences.getString(KEY_SDK_KEY_ID, null) ?: return null
    val secret = preferences.getString(KEY_SDK_SECRET, null) ?: return null
    val sdkVersion = preferences.getString(KEY_SDK_VERSION, null) ?: SDK_VERSION
    return OpenMmpConfiguration(endpoint, keyId, secret, sdkVersion = sdkVersion)
  }

  fun clearAfterDeletion() {
    preferences.edit()
      .remove(KEY_INSTALLATION_KEY_ID)
      .remove(KEY_INSTALLATION_SECRET)
      .remove(KEY_SEQUENCE)
      .commit()
  }

  companion object {
    const val SUBTREE = "openmmp"
    const val PREFERENCES = "openmmp_private"
    const val SDK_VERSION = "0.1.0"
    private const val KEY_INSTALLATION_ID = "installation_id"
    private const val KEY_COLLECTION_ENABLED = "collection_enabled"
    private const val KEY_REFERRER_CONSUMED = "referrer_consumed"
    private const val KEY_SEQUENCE = "processing_sequence"
    private const val KEY_INSTALLATION_KEY_ID = "installation_key_id"
    private const val KEY_INSTALLATION_SECRET = "installation_secret"
    private const val KEY_ENDPOINT = "endpoint"
    private const val KEY_SDK_KEY_ID = "sdk_key_id"
    private const val KEY_SDK_SECRET = "sdk_secret"
    private const val KEY_SDK_VERSION = "sdk_version"
  }
}

data class InstallationCredential(val keyId: String, val secret: String)
