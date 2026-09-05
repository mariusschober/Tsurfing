# Historical credential actions

Status captured 2026-09-03. This is a release-blocking security ledger, not a
place to paste credentials. Record only non-secret identifiers and hashes.

## Historical Firebase / Google API key

**Status: RETIRED BY PROJECT DELETION; EXACT FINDING ACKNOWLEDGED.**

Forensic evidence:

- Commit `84bd036ba25d825b5fae36cb780842d9221ed097` contains
  `firebase-applet-config.json` with a syntactically valid Google API key and a
  coherent Firebase client configuration for project `upheld-flow-201513`.
- Commit `7fa5a17e2b8892df91c2b23c4e551b67031731db` deletes the file. It is absent
  from the current candidate tree but remains recoverable from public history.
- The value is therefore treated as a real Firebase client API key. Firebase
  client keys are not equivalent to a server credential, but an unrestricted
  key can still be abused for enabled Google APIs or quota consumption.
- The owner confirmed on 2026-09-04 that the Firebase project was deleted and
  no longer exists. The current candidate contains no Firebase configuration or
  code. A local calculation produced only the SHA-256 fingerprint recorded
  below; the key itself was neither printed nor transmitted.
- `.gitleaksignore` acknowledges only the exact commit/path/rule/line finding.
  No broad rule/path allowlist and no history rewrite has been added. Future
  Firebase/GCP-shaped findings still fail the gate.

Completed owner action and verification boundary:

1. Owner Marius Schober reported that project `upheld-flow-201513` was deleted
   and no longer exists. Tsurfing has no current dependency on that project.
2. The candidate tree was checked for tracked Firebase and Google Services
   files; none exists. The historical file was deleted in commit `7fa5a17`.
3. A one-way key fingerprint was computed locally from the historical commit.
   The execution environment declined a proposed read-only Google API probe
   because it would transmit the historical key; that independent probe was not
   attempted again and is not claimed as evidence.
4. Because the project has been deleted, there are no allowed APIs,
   application restrictions, live quotas, or retained Firebase resources for
   Tsurfing. A pre-deletion usage report was not supplied and cannot be inferred.
5. The exact Gitleaks finding fingerprint is now acknowledged. Hosted
   complete-history scanning remains the authority that the acknowledgement is
   exact and no additional finding is hidden.

Completion record:

```text
Date: 2026-09-04 (owner confirmation date; original console deletion timestamp unavailable)
Operator: Marius Schober (owner attestation); Codex (local tree and fingerprint verification)
Disposition (revoked / rotated / restricted): Firebase project upheld-flow-201513 deleted; historical client key retired
Allowed APIs / application restrictions: None; deleted project
One-way key fingerprint: sha256:e0cb8e2e8d8953b9c1df5cd6b481e134025678d8ed5be49c963d55530bb54913
Usage review result: No pre-deletion usage report supplied; owner confirms project no longer exists; no credential-bearing API probe performed
```

## Synthetic Telegram fixtures

**Status: VERIFIED SYNTHETIC; exact fingerprints ignored.**

The remaining two `generic-api-key` findings originate only from hard-coded
`TELEGRAM_WEBHOOK_SECRET` values in test files on the archived Telegram branch:

- commit `04aa5b4d97de0f626bd824c6b1c51c651cc14a1d`,
  `server/telegram/bot.adversarial.test.ts`, line 90;
- commit `bb5c7af0908dde92913795cd149a1c3ab6e3df06`,
  `server/telegram/bot.test.ts`, line 139.

They are test-only invented strings, are not present in the canonical tree,
and cannot authenticate to a Telegram bot or deployed Tsurfing service. Their
two exact Gitleaks fingerprints are listed in `.gitleaksignore`; the Telegram
rule, file paths, commits, and other findings remain scanned. When Telegram is
ported, fixtures must use conspicuously synthetic low-entropy construction so
new commits do not require additional ignores.

## Historical Android test signer

**Status: RETIRED TEST-ONLY IDENTITY; DO NOT REUSE FOR BETA.**

A password-like value for a temporary Android test keystore appeared in the
current copy of a historical readiness snapshot and has been redacted. A
complete filename audit across all refs found no tracked `.keystore`, `.jks`,
`.p12`, `.pem`, or private-key file, so the value alone cannot sign an APK. It
is nevertheless not acceptable beta signing material. The internal beta must
use an externally retained key, and its expected certificate SHA-256 fingerprint
must be configured independently before the signed-artifact workflow runs.

## History-rewrite decision

History is not rewritten at this stage. Every branch head has already been
audited and tagged, the Firebase value is a client configuration identifier
rather than a service-role credential, and rewriting all published branches
would invalidate the existing provenance. Reconsider coordinated history
rewriting only if the owner confirms the historical value grants materially
privileged access that cannot be neutralized by revocation or restriction.
