# Releasing and deployment

[Contributor guide](../../DEVELOPMENT.md) · [Development docs](README.md)

Commands and code paths below are relative to the repository root unless stated
otherwise.

## Releasing to npm

The package is published to npm as `yepanywhere` using GitHub Actions with OIDC trusted publishing (no npm tokens stored in secrets).

**Before releasing:**

1. Update `CHANGELOG.md` with a new version section:
   ```markdown
   ## [0.1.11] - 2025-01-24

   ### Added
   - New feature description

   ### Fixed
   - Bug fix description
   ```

2. Commit the changelog update

3. Tag and push:
   ```bash
   git tag v0.1.11
   git push origin v0.1.11
   ```

The CI workflow verifies the changelog contains an entry for the version being released. If missing, the release will fail with instructions to update the changelog.

The workflow runs lint, typecheck, and tests, then builds with `pnpm build:bundle` and publishes with `--provenance` for supply chain attestation. It also creates a GitHub Release with auto-generated notes.

## Releasing the Codex DevBox fork

The Codex DevBox fork publishes a prebuilt server bundle through GitHub Releases.
Users do not select a branch, commit, source directory, or package version.

From a clean fork commit with the intended compatibility changes:

```bash
VERSION=0.11.0-codexdevbox.1
git tag "codexdevbox-v$VERSION"
git push fork "codexdevbox-v$VERSION"
```

The tag workflow validates the Codex compatibility boundary, builds the bundle,
and publishes these assets:

- `yepanywhere-<version>.tgz`
- `release-manifest.json`
- `install-codexdevbox.sh`
- `SHA256SUMS`

The installer URL is stable across releases:

```text
https://github.com/Tada0311/yepanywhere/releases/latest/download/install-codexdevbox.sh
```

The downloaded installer embeds the resolved release URL. It verifies the
archive checksum, installs under `$HOME/.local`, and writes the selected release,
absolute CLI path, Node path, and npm path to
`$HOME/.codexdevbox/install.json`. If the available Node.js does not satisfy the
package runtime, the installer downloads a checksum-verified managed runtime and
binds the stable `$HOME/.local/bin/yepanywhere` launcher to it. Automation should
invoke that launcher and consume the state file instead of asking users for
release metadata, runtime paths, source branches, commits, or a source directory.

## Releasing the Website

The website (landing pages + remote relay client at `/remote`) is deployed to GitHub Pages separately from npm. **Pushing to main does NOT deploy the site** — it only runs CI (lint, typecheck, tests). The site only deploys when a `site-v*` tag is pushed (or via manual workflow_dispatch).

See [site/RELEASING.md](../../site/RELEASING.md) for the full process.

Quick reference:
```bash
# Update site/CHANGELOG.md first, then:
scripts/release-website.sh 1.5.3
```

## Releasing the Chrome extension

Update and commit `packages/browser-extension/CHANGELOG.md`, then run
`scripts/release-extension.sh <version>` from a clean `main` checkout. The
helper bumps the independent extension version and pushes its release tag.
CI accepts the exact ZIP, submits it through keyless Google authentication,
and records a GitHub release. Google review remains asynchronous. See
[Chrome Web Store publication](../distribution/chrome-extension/README.md)
for setup, read-only verification and listing/privacy requirements.

## Deploying to Staging

The staging deploy runbook is host-specific and intentionally kept out of this public
repo. It lives in the private dotfiles repo: `~/code/dotfiles/machines/pi/README.md`. If
asked to deploy to staging, read the steps there.

## Preparing native mobile stores

See [mobile store preparation](../distribution/mobile/README.md) for shared
listing copy, existing icons, initial artwork, and the boundary between internal
testing and public store submission. Private account and credential inventory
lives in the dotfiles runbooks.

## Coordinated source releases

For a coordinated release, prepare all product version metadata and changelogs
in one commit on `main`. The standalone desktop and extension helpers normally
create their own version commits; applying those metadata changes together
keeps the release tags on one source revision. Validate the clean source,
unused versions, changelogs and extension store identity before atomically
pushing `main` with its npm, desktop and extension release tags. The tagged
workflows retain their normal tests, exact-ZIP acceptance, signing and
publication checks.

Dispatch the Android internal release on that same `main` revision and verify
the workflow's `headSha` matches the coordinated release commit. The dispatch
pins its source; later branch movement does not change the selected artifact.
Chrome review and Android public-beta promotion remain separate delivery steps.
