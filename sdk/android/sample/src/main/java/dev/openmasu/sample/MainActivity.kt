package dev.openmasu.sample

import android.app.Activity
import android.os.Bundle
import android.content.Intent
import android.widget.TextView
import dev.openmasu.sdk.OpenMasuSdk

class MainActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    sdk?.handleDeepLink(intent)
    setContentView(TextView(this).apply { text = "OpenMasu synthetic sample" })
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    sdk?.handleDeepLink(intent)
  }

  companion object {
    /** Set by the host application after constructing and configuring its SDK instance. */
    var sdk: OpenMasuSdk? = null
  }
}
