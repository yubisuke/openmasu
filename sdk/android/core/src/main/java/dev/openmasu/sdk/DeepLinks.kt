package dev.openmasu.sdk

import android.content.Intent
import android.net.Uri

data class OpenMasuDeepLink(
  val value: String?,
  val parameters: Map<String, String>,
  val openSource: String,
  val destinationStatus: String,
  val linkSlug: String? = null,
  val clickId: String? = null,
)

fun interface OpenMasuDeepLinkListener {
  fun onDeepLink(value: OpenMasuDeepLink)
}

internal object DeepLinkParser {
  private val slug = Regex("^[A-Za-z0-9_-]{12,64}$")
  private val segment = Regex("^[A-Za-z0-9._~-]{1,64}$")
  private val parameter = Regex("^dlp_([a-z][a-z0-9_]{0,63})$")

  fun direct(intent: Intent, allowedHosts: Set<String>, allowedSchemes: Set<String> = emptySet()): OpenMasuDeepLink? {
    if (intent.action != Intent.ACTION_VIEW) return null
    val uri = intent.data ?: return null
    val scheme = uri.scheme?.lowercase() ?: return null
    val isWeb = scheme in setOf("http", "https")
    if (!isWeb && scheme !in allowedSchemes.map { it.lowercase() }.toSet()) return null
    val host = uri.host?.lowercase()?.trimEnd('.') ?: return null
    if (host !in allowedHosts.map { it.lowercase().trimEnd('.') }.toSet()) return null
    val parts = uri.pathSegments
    if (parts.size < 2 || parts[0] != "r" || !slug.matches(parts[1])) return null
    val destination = parts.drop(2)
    val destinationValid = destination.size <= 8 && destination.all { segment.matches(it) && it != "." && it != ".." }
    val params = linkedMapOf<String, String>()
    for (name in uri.queryParameterNames.sorted()) {
      val match = parameter.matchEntire(name) ?: continue
      val value = uri.getQueryParameter(name) ?: continue
      if (params.size < 10 && value.matches(Regex("^[A-Za-z0-9._~-]{1,64}$"))) params[match.groupValues[1]] = value
    }
    return OpenMasuDeepLink(
      value = destination.takeIf { destinationValid && it.isNotEmpty() }?.joinToString("/", prefix = "/"),
      parameters = params,
      openSource = if (isWeb) "android_app_link" else "custom_scheme",
      destinationStatus = when {
        !destinationValid -> "rejected"
        destination.isEmpty() -> "absent"
        else -> "delivered"
      },
      linkSlug = parts[1],
    )
  }

  fun fromReferrer(evidence: PlayReferrerEvidence): OpenMasuDeepLink? {
    if (evidence.deferredDeepLinkStatus != "delivered" || evidence.deepLinkValue == null) return null
    return OpenMasuDeepLink(
      value = evidence.deepLinkValue,
      parameters = evidence.deepLinkParameters,
      openSource = "android_deferred_referrer",
      destinationStatus = evidence.deferredDeepLinkStatus,
      clickId = evidence.clickId,
    )
  }
}
