import AppKit
import SwiftUI

private enum EmailAuthStage { case request, verify }

struct SignInView: View {
    @State private var email = ""
    @State private var inviteCode = ""
    @State private var emailCode = ""
    @State private var purpose: PendingEmailOtpAttempt.Purpose = .signIn
    @State private var stage: EmailAuthStage = .request
    @State private var message = ""
    @State private var isSending = false
    @State private var captchaToken = ""
    @State private var captchaRevision = 0
    @State private var resendAt = Date.distantPast
    @State private var mfaCode = ""
    @State private var requiresMFA = false
    @State private var profile: GoalflowSessionProfile?
    @State private var telegramStatus: MacTelegramStatus?
    @State private var isLoadingTelegram = false
    @State private var confirmTelegramUnlink = false
    var accountMode = false
    var onClose: (() -> Void)?

    private let auth = SupabaseAuthService.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Tsurfing account").font(.system(size: 16, weight: .semibold, design: .rounded))
                Spacer()
                if let close = onClose {
                    Button(action: close) { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                        .buttonStyle(.plain)
                }
            }

            if accountMode, let profile {
                accountContent(profile)
            } else {
                authenticationContent
            }

            if !auth.isConfigured {
                Text(auth.configurationProblem ?? "Cloud authentication is not configured. Local changes remain on this Mac.")
                    .font(.system(size: 10, weight: .medium)).foregroundStyle(.orange).lineLimit(2)
            }

            if requiresMFA {
                Divider()
                Text("Owner verification").font(.system(size: 12, weight: .semibold, design: .rounded))
                HStack(spacing: 8) {
                    SecureField("6-digit authenticator code", text: $mfaCode).textFieldStyle(.roundedBorder)
                    Button("Verify") { Task { await verifyMFA() } }
                        .buttonStyle(.borderedProminent)
                        .disabled(mfaCode.count != 6 || isSending)
                }
            }

            if !message.isEmpty {
                Text(message).font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary).lineLimit(3)
            }
            Text("Closing this panel keeps Tsurfing local-first; cloud sync is shown only after server activation succeeds.")
                .font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(2)
        }
        .padding(16)
        .frame(width: 380)
        .background(RoundedRectangle(cornerRadius: 14).fill(.ultraThinMaterial))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.primary.opacity(0.08), lineWidth: 1))
        .task { await refreshSessionState() }
        .onReceive(NotificationCenter.default.publisher(for: .authDidChange)) { _ in
            Task { await refreshSessionState() }
        }
        .confirmationDialog(
            "Unlink Telegram from this Tsurfing account?",
            isPresented: $confirmTelegramUnlink,
            titleVisibility: .visible
        ) {
            Button("Unlink Telegram", role: .destructive) { Task { await unlinkTelegram() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Telegram sign-in and Bot access will stop until you explicitly link it again.")
        }
    }

    @ViewBuilder
    private var authenticationContent: some View {
        Picker("Account access", selection: $purpose) {
            Text("Sign in").tag(PendingEmailOtpAttempt.Purpose.signIn)
            Text("Join beta").tag(PendingEmailOtpAttempt.Purpose.activation)
        }
        .pickerStyle(.segmented)
        .disabled(isSending || stage == .verify)

        if stage == .request {
            Text("Tsurfing sends a six-digit code. Passwords and email links are not accepted.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
            TextField("email@example.com", text: $email)
                .textFieldStyle(.roundedBorder).font(.system(size: 13))
            if purpose == .activation {
                TextField("Beta invite code", text: $inviteCode)
                    .textFieldStyle(.roundedBorder).font(.system(size: 13))
            }
            if let captchaURL = auth.nativeCaptchaURL {
                NativeCaptchaView(
                    url: captchaURL,
                    revision: captchaRevision,
                    onToken: { token in
                        captchaToken = token
                        message = "Human verification complete."
                    },
                    onError: { message = $0 }
                )
                .frame(height: 82)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
            Button(action: { Task { await sendCode() } }) {
                if isSending { ProgressView().scaleEffect(0.7) }
                else { Text("Send email code").font(.system(size: 12, weight: .bold, design: .rounded)) }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(email.isEmpty || captchaToken.isEmpty || isSending || (purpose == .activation && inviteCode.count < 6))

            if auth.isTelegramConfigured {
                HStack(spacing: 8) {
                    Rectangle().fill(Color.primary.opacity(0.1)).frame(height: 1)
                    Text("or").font(.system(size: 10)).foregroundStyle(.secondary)
                    Rectangle().fill(Color.primary.opacity(0.1)).frame(height: 1)
                }
                Button(purpose == .activation ? "Join beta with Telegram" : "Continue with Telegram") {
                    Task { await beginTelegramAuthentication() }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(isSending || (purpose == .activation && (inviteCode.count < 6 || captchaToken.isEmpty)))
            }
        } else {
            Text("Enter the six-digit code sent to \(email). It expires in ten minutes.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
            SecureField("6-digit email code", text: $emailCode)
                .textFieldStyle(.roundedBorder)
                .onChange(of: emailCode) { _, value in
                    emailCode = String(value.filter(\.isNumber).prefix(6))
                }
            HStack {
                Button("Verify code") { Task { await verifyCode() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(emailCode.count != 6 || isSending)
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let resendSeconds = max(0, Int(resendAt.timeIntervalSince(context.date).rounded(.up)))
                    Button(resendSeconds > 0 ? "Request another code in \(resendSeconds)s" : "Request another code") {
                        resetRequest()
                    }
                    .buttonStyle(.bordered)
                    .disabled(isSending || resendSeconds > 0)
                }
            }
        }
    }

    @ViewBuilder
    private func accountContent(_ profile: GoalflowSessionProfile) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(profile.email).font(.system(size: 13, weight: .semibold))
            Text(profile.requiresMFA ? "Owner verification required" : "Cloud session verified")
                .font(.system(size: 11)).foregroundStyle(profile.requiresMFA ? Color.orange : Color.secondary)
        }

        Divider()
        Text("Telegram").font(.system(size: 12, weight: .semibold, design: .rounded))
        if !auth.isTelegramConfigured {
            Text("Telegram linking is disabled for this build.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
        } else if isLoadingTelegram {
            ProgressView().controlSize(.small)
        } else if let telegramStatus {
            if telegramStatus.enabled && telegramStatus.linked {
                Text(telegramStatus.username.map { "Linked as @\($0)" } ?? "Telegram is linked")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                Button("Unlink Telegram", role: .destructive) { confirmTelegramUnlink = true }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(isSending || profile.requiresMFA)
            } else if telegramStatus.enabled {
                Text("Linking is explicit. Tsurfing never matches accounts by email, phone, or username.")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                Button("Link Telegram…") { Task { await linkTelegram() } }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(isSending || profile.requiresMFA)
            } else {
                Text("Telegram linking is not enabled by the server.")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
        } else {
            Button("Retry Telegram status") { Task { await loadTelegramStatus() } }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(isSending)
        }
    }

    private func sendCode() async {
        isSending = true
        defer { isSending = false }
        do {
            let pending = try await auth.requestEmailCode(
                email: email,
                purpose: purpose,
                inviteCode: purpose == .activation ? inviteCode : "",
                captchaToken: captchaToken
            )
            email = pending.email
            resendAt = pending.resendAt
            emailCode = ""
            captchaToken = ""
            stage = .verify
            message = "If this address is approved, a six-digit code will arrive."
        } catch {
            message = error.localizedDescription
            captchaToken = ""
            captchaRevision += 1
        }
    }

    private func verifyCode() async {
        isSending = true
        defer { isSending = false }
        do {
            let profile = try await auth.verifyEmailCode(email: email, code: emailCode)
            requiresMFA = profile.requiresMFA
            message = profile.requiresMFA ? "Email verified. Complete owner verification." : "Signed in as \(profile.email)."
            if !profile.requiresMFA { onClose?() }
        } catch {
            message = error.localizedDescription
        }
    }

    private func beginTelegramAuthentication() async {
        isSending = true
        defer { isSending = false }
        do {
            let url: URL
            if purpose == .activation {
                url = try await auth.beginTelegramActivation(inviteCode: inviteCode, captchaToken: captchaToken)
                captchaToken = ""
                captchaRevision += 1
            } else {
                url = try auth.beginTelegramSignIn()
            }
            guard NSWorkspace.shared.open(url) else { throw AuthError.browserUnavailable }
            message = "Complete Telegram sign-in in your browser, then return to Tsurfing."
        } catch {
            message = error.localizedDescription
            if purpose == .activation {
                captchaToken = ""
                captchaRevision += 1
            }
        }
    }

    private func linkTelegram() async {
        isSending = true
        defer { isSending = false }
        do {
            if let url = try await auth.beginTelegramLink() {
                guard NSWorkspace.shared.open(url) else { throw AuthError.browserUnavailable }
                message = "Confirm the Telegram identity in your browser, then return to Tsurfing."
            } else {
                await loadTelegramStatus()
                message = "Telegram is linked."
            }
        } catch AuthError.mfaRequired {
            requiresMFA = true
            message = AuthError.mfaRequired.localizedDescription
        } catch {
            message = error.localizedDescription
        }
    }

    private func unlinkTelegram() async {
        isSending = true
        defer { isSending = false }
        do {
            telegramStatus = try await auth.unlinkTelegram()
            message = "Telegram was unlinked."
        } catch AuthError.mfaRequired {
            requiresMFA = true
            message = AuthError.mfaRequired.localizedDescription
        } catch {
            message = error.localizedDescription
        }
    }

    private func loadTelegramStatus() async {
        guard auth.isTelegramConfigured else { return }
        isLoadingTelegram = true
        defer { isLoadingTelegram = false }
        do {
            telegramStatus = try await auth.telegramStatus()
        } catch {
            telegramStatus = nil
            message = error.localizedDescription
        }
    }

    private func resetRequest() {
        guard Date() >= resendAt else { return }
        stage = .request
        emailCode = ""
        captchaToken = ""
        captchaRevision += 1
        message = ""
    }

    private func refreshSessionState() async {
        guard auth.isConfigured else { return }
        if let pending = try? auth.pendingEmailCodeRequest() {
            email = pending.email
            purpose = pending.purpose
            resendAt = pending.resendAt
            if pending.expiresAt > Date() { stage = .verify }
        }
        do {
            let currentProfile = try await auth.validateCurrentSession()
            profile = currentProfile
            requiresMFA = currentProfile.requiresMFA
            if accountMode {
                await loadTelegramStatus()
            } else if !currentProfile.requiresMFA {
                message = "Signed in as \(currentProfile.email)."
                onClose?()
            }
        } catch KeychainError.noSession, KeychainError.activationPending {
            profile = nil
            requiresMFA = false
        } catch {
            profile = nil
            message = error.localizedDescription
        }
    }

    private func verifyMFA() async {
        isSending = true
        defer { isSending = false }
        do {
            let currentProfile = try await auth.completeMFA(code: mfaCode)
            profile = currentProfile
            requiresMFA = currentProfile.requiresMFA
            message = "Signed in as \(currentProfile.email)."
            if accountMode { await loadTelegramStatus() }
            else { onClose?() }
        } catch {
            message = error.localizedDescription
        }
    }
}
