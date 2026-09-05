package com.mariusschober.goalflow.nativeapp.ui

import android.annotation.SuppressLint
import android.net.Uri
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceResponse
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.mariusschober.goalflow.nativeapp.sync.NativeConfig

private val TURNSTILE_TOKEN = Regex("^[A-Za-z0-9._~-]{20,4096}$")

private class CaptchaBridge(
    private val webView: WebView,
    private val onToken: (String) -> Unit
) {
    @JavascriptInterface
    fun complete(token: String) {
        if (!token.matches(TURNSTILE_TOKEN)) return
        webView.post { onToken(token) }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
internal fun NativeCaptchaView(
    revision: Int,
    onToken: (String) -> Unit,
    onError: (String) -> Unit
) {
    val expectedOrigin = remember { Uri.parse(NativeConfig.apiOrigin) }
    val challengeUrl = remember(revision) {
        "${NativeConfig.apiOrigin}/api/v1/auth/email/captcha"
    }
    val retainedWebView = remember(revision) { arrayOfNulls<WebView>(1) }

    AndroidView(
        modifier = Modifier.fillMaxWidth().heightIn(min = 78.dp, max = 118.dp),
        factory = { context ->
            WebView(context).apply {
                retainedWebView[0] = this
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                settings.safeBrowsingEnabled = true
                CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
                addJavascriptInterface(CaptchaBridge(this, onToken), "TsurfingNativeCaptcha")
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                        val target = request.url
                        val exactOrigin = target.scheme.equals(expectedOrigin.scheme, ignoreCase = true)
                            && target.host.equals(expectedOrigin.host, ignoreCase = true)
                            && target.port == expectedOrigin.port
                        if (request.isForMainFrame) return !exactOrigin
                        val isTurnstileFrame = target.scheme.equals("https", ignoreCase = true)
                            && target.host.equals("challenges.cloudflare.com", ignoreCase = true)
                        return !isTurnstileFrame
                    }

                    override fun onReceivedError(
                        view: WebView,
                        request: WebResourceRequest,
                        error: WebResourceError
                    ) {
                        if (request.isForMainFrame) onError("Human verification could not load. Check the connection.")
                    }

                    override fun onReceivedHttpError(
                        view: WebView,
                        request: WebResourceRequest,
                        errorResponse: WebResourceResponse
                    ) {
                        if (request.isForMainFrame) onError("Human verification is unavailable. Try again later.")
                    }

                    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: android.net.http.SslError) {
                        handler.cancel()
                        onError("Human verification refused an unsafe connection.")
                    }
                }
                loadUrl(challengeUrl)
            }
        },
        update = { view ->
            if (view.url != challengeUrl) view.loadUrl(challengeUrl)
        }
    )

    DisposableEffect(revision) {
        onDispose {
            retainedWebView[0]?.apply {
                removeJavascriptInterface("TsurfingNativeCaptcha")
                stopLoading()
                loadUrl("about:blank")
                clearHistory()
                destroy()
            }
            retainedWebView[0] = null
        }
    }
}
