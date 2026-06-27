# Signing the permission-helper binaries (C.1)

The `agent-index://` helper binaries must be **code-signed** so the OS will run them:

- **Windows** — *required and the critical path.* Smart App Control (default-on, Windows 11) **hard-blocks unsigned binaries with no per-app user bypass** (bug `20260626-8d20ea22-2`). Unsigned = the helper simply does not run for default-secure members.
- **macOS** — required if/when you have Mac members. Gatekeeper blocks un-notarized binaries, and the `.app` must be signed+notarized to register `agent-index://` (bug `20260626-8d20ea22`).
- **Linux** — *optional.* No OS gatekeeper; signing is provenance-only.

**Golden rule:** sign **before** computing checksums. `infrastructure-directory.json` pins the SHA-256 of the **signed** bytes, so signing after hashing would make every member's SHA-verify fail. `build-all.sh` enforces the order (sign stage → checksums → `verify-signed.sh` gate).

The build calls an optional `sign.sh "$VERSION"` (per-environment, you provide it) and then `verify-signed.sh`. Below are the procurement steps and the exact `sign.sh` contents per platform.

---

## The signing switch (bypass while certs are pending)

Certs take weeks (Trusted Signing org validation; Apple enrollment). Until they land, run the whole pipeline **unsigned** with one switch, then flip to enforced.

**One switch, two states:**

| | `SIGN=1` (default — enforced) | `SIGN=0` (bypass — interim) |
|---|---|---|
| build-all.sh | signs (`sign.sh`) + `verify-signed.sh` gate fails if unsigned | skips signing + gate; builds UNSIGNED with real SHAs; prints a bypass banner |
| directory `signing` field | `"trusted"` | `"unsigned-bypass"` |
| runtime (apply-updates / member-bootstrap / clone-script) | an OS block = a release/signing **defect** | an OS block is **expected**; surface the SAC Evaluation-mode workaround below, not a defect |
| ms-install-7 signing gate | "SAC does not block the helper" | "helper works with SAC in **Evaluation mode**" |

**To ship the interim unsigned build now:**
1. `SIGN=0 bash build-all.sh 0.6.0` → unsigned binaries + `.app` + real SHAs.
2. Paste those SHAs into `infrastructure-directory.json`, and set both binary entries' `"signing": "unsigned-bypass"` (already the current value).
3. Push + run ms-install-7. Testers on default-secure Windows 11 enable **Smart App Control Evaluation mode** (set `HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy → VerifiedAndReputablePolicyState = 2`, reboot) so SAC observes without blocking. macOS testers may need to right-click → Open the unsigned `.app` once.

**To flip to signed later (one pass):**
1. Obtain certs, provide `sign.sh`.
2. **Bump the binary version** (e.g. 0.6.0 → 0.6.1) — REQUIRED so members re-download the signed bytes (`apply-updates` no-ops on an unchanged version even if the SHA changed).
3. `SIGN=1 bash build-all.sh 0.6.1` → signs + verify gate.
4. Fill the signed SHAs, set `"signing": "trusted"`, push. Done — no other code changes.

The switch is the `SIGN` env var (build) + the directory `signing` field (runtime). Nothing else needs to change between the two modes.

---

## Windows — Microsoft Trusted Signing (recommended)

**One-time setup (the slow part — start first):**
1. Azure subscription → create a **Trusted Signing account** → a **certificate profile** (type: *Public Trust*).
2. Complete **organization identity validation** in the portal (needs the *Artifact Signing Identity Verifier* role on the account, and your org's legal name + address — must match your D-U-N-S / state filing). Approval is 1–20 days, can't be expedited.
3. Assign yourself the **Artifact Signing Certificate Profile Signer** role (so you can sign).
4. Install signing tooling: the Windows SDK `signtool` + the **Trusted Signing dlib** (`Microsoft.Trusted.Signing.Client`), or use the `azure/trusted-signing-action` in CI.

**Signing (on Windows / Windows CI runner)** — `sign-windows.ps1`:
```powershell
param([string]$Version)
$files = Get-ChildItem dist\agent-index-show-plan-$Version-windows-*.exe
$dlib  = "C:\path\to\Microsoft.Trusted.Signing.Client\bin\x64\Azure.CodeSigning.Dlib.dll"
$meta  = "C:\path\to\trusted-signing-metadata.json"   # { Endpoint, CodeSigningAccountName, CertificateProfileName }
foreach ($f in $files) {
  & signtool sign /v /debug /fd SHA256 /tr "http://timestamp.acs.microsoft.com" /td SHA256 `
      /dlib $dlib /dmdf $meta $f.FullName
}
# verify
foreach ($f in $files) { & signtool verify /pa /v $f.FullName }
```
EV certificate alternative: same `signtool` call with `/n "Agent Index Inc"` against the EV cert on its hardware token / cloud HSM (no dlib).

---

## macOS — Developer ID + notarization

**One-time setup:**
1. **Apple Developer Program** ($99/yr), enrolled as the **organization** (needs your D-U-N-S — same one). Individual enrollment is faster but puts your personal name on the cert.
2. Create a **Developer ID Application** certificate (Apple Developer → Certificates), install in the login Keychain. (Add **Developer ID Installer** only if shipping a `.pkg`.)
3. Save notarization creds once: `xcrun notarytool store-credentials AC --apple-id you@org.com --team-id TEAMID --password <app-specific-password>` (or use an App Store Connect API key).

**Signing (must run on macOS / a macOS CI runner)** — the macOS arm of `sign.sh`:
```bash
TEAM="Developer ID Application: Agent Index Inc (TEAMID)"
for arch in amd64 arm64; do
  app="dist/Agent-Index Helper-${VERSION}-darwin-${arch}.app"
  bin="dist/agent-index-show-plan-${VERSION}-darwin-${arch}"
  codesign --force --options runtime --timestamp --sign "$TEAM" "$bin"          # sign the bare binary too
  codesign --force --deep --options runtime --timestamp --sign "$TEAM" "$app"   # sign the .app
  ditto -c -k --keepParent "$app" "dist/notarize-${arch}.zip"                    # notarytool needs a zip
  xcrun notarytool submit "dist/notarize-${arch}.zip" --keychain-profile AC --wait
  xcrun stapler staple "$app"                                                    # staple the ticket
  ditto -c -k --keepParent "$app" "dist/Agent-Index-Helper-${VERSION}-darwin-${arch}.app.zip"  # re-zip stapled
done
```

---

## Linux — optional GPG provenance

No OS gatekeeper. If you want verifiable provenance, set `SIGN_LINUX=1` and add to `sign.sh`:
```bash
for arch in amd64 arm64; do
  gpg --armor --detach-sign "dist/agent-index-show-plan-${VERSION}-linux-${arch}"   # → .asc
done
# publish your public key; reference the .asc URLs in infrastructure-directory.json
```

---

## Putting it together

1. `sign.sh "$VERSION"` (you provide, per your signing host/CI) signs the Windows `.exe`s, the macOS binaries + `.app`s (+ notarize/staple), and optionally Linux.
2. `build-all.sh` runs it before checksums, then runs `verify-signed.sh` as a hard gate.
3. Paste the post-signing SHA-256s into `infrastructure-directory.json` and re-release.

Until signing is fully live you may ship testers with `ALLOW_UNSIGNED=1 SIGN=0` and the documented **Smart App Control Evaluation-mode** workaround — but that is testing-only and must not reach customer B.

<!-- AIFS:FILE-END -->
