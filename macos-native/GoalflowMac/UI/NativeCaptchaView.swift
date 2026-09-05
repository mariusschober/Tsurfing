import SwiftUI
import WebKit

struct NativeCaptchaView: NSViewRepresentable {
    let url: URL
    let revision: Int
    let onToken: (String) -> Void
    let onError: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(expectedOrigin: url, onToken: onToken, onError: onError)
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.userContentController.add(context.coordinator, name: "tsurfingCaptcha")
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        context.coordinator.loadedRevision = revision
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData))
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.onToken = onToken
        context.coordinator.onError = onError
        guard context.coordinator.loadedRevision != revision else { return }
        context.coordinator.loadedRevision = revision
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData))
    }

    static func dismantleNSView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "tsurfingCaptcha")
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        let expectedScheme: String?
        let expectedHost: String?
        let expectedPort: Int?
        var onToken: (String) -> Void
        var onError: (String) -> Void
        var loadedRevision = -1

        init(expectedOrigin: URL, onToken: @escaping (String) -> Void, onError: @escaping (String) -> Void) {
            expectedScheme = expectedOrigin.scheme?.lowercased()
            expectedHost = expectedOrigin.host?.lowercased()
            expectedPort = Self.normalizedPort(scheme: expectedOrigin.scheme, port: expectedOrigin.port)
            self.onToken = onToken
            self.onError = onError
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            let origin = message.frameInfo.securityOrigin
            guard message.name == "tsurfingCaptcha",
                  message.frameInfo.isMainFrame,
                  origin.protocol.lowercased() == expectedScheme,
                  origin.host.lowercased() == expectedHost,
                  Self.normalizedPort(scheme: origin.protocol, port: origin.port) == expectedPort,
                  let token = message.body as? String,
                  token.count >= 20, token.count <= 4_096,
                  token.range(of: #"^[A-Za-z0-9._~-]+$"#, options: .regularExpression) != nil else { return }
            onToken(token)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard navigationAction.targetFrame?.isMainFrame == true, let target = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }
            let exactOrigin = target.scheme?.lowercased() == expectedScheme
                && target.host?.lowercased() == expectedHost
                && Self.normalizedPort(scheme: target.scheme, port: target.port) == expectedPort
            decisionHandler(exactOrigin ? .allow : .cancel)
        }

        private static func normalizedPort(scheme: String?, port: Int?) -> Int? {
            if let port, port != 0 { return port }
            switch scheme?.lowercased() {
            case "https": return 443
            case "http": return 80
            default: return nil
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            onError("Human verification could not load. Check the connection.")
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            onError("Human verification could not load. Check the connection.")
        }
    }
}
