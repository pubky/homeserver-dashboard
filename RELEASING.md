# Releasing homeserver-dashboard

A release is a version PR followed by a tag. The tag publishes the Docker image and the release archive. Umbrel users get the release only after a further step in `pubky/umbrel-app-store`.

## Prerequisites

- Push access to the repository (to create tags)
- `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` secrets configured in GitHub repo settings (Settings > Secrets and variables > Actions), with push access to `synonymsoft/homeserver-dashboard`

## Release Steps

### 1. Bump the version and create the version PR

Make sure you are working on the most recent main branch.

```bash
git checkout main
git pull origin main
```

Bump the version. This updates `package.json` and `package-lock.json` and creates no commit or tag:

```bash
npm version 0.2.0 --no-git-tag-version
```

Add a `## [0.2.0]` section at the top of `CHANGELOG.md`, with an entry for every change merged since the last release. Feature PRs do not touch the changelog, so this is where the entries get written. `git log v0.1.34..main --oneline` lists what to cover.

Create the version PR:

```bash
git checkout -b chore/v0.2.0
git add -A
git commit -m "chore: v0.2.0"
git push origin chore/v0.2.0
```

PR title: `chore: v0.2.0`

### 2. Tag and push

After the version PR has been reviewed and merged:

```bash
git checkout main
git pull origin main
git tag v0.2.0
git push origin v0.2.0
```

This triggers both release workflows. Tag the commit on `main` that carries the version bump: only one of the two workflows checks that the tag matches `package.json` (see below).

### 3. Update the Umbrel app

Nothing reaches Umbrel users until [`pubky/umbrel-app-store`](https://github.com/pubky/umbrel-app-store) pins the new image by digest and bumps its own app version. That repo's README documents its versioning scheme. If the release changed the `cloudflared` version in the Dockerfile, bump the app's tunnel containers to the same version in the same change.

## What CI Does Automatically

When a `v*.*.*` tag is pushed, two workflows run independently of each other.

The [Docker workflow](.github/workflows/docker.yml):

1. **Builds the image** for linux/amd64 and linux/arm64
2. **Pushes it to Docker Hub** as `synonymsoft/homeserver-dashboard:<tag>` and `latest`

It does not check the tag against `package.json`.

The [release archive workflow](.github/workflows/release.yml):

1. **Validates** that the tag matches the version in `package.json`
2. **Builds the bundle** and packs it with a Node.js binary into `homeserver-dashboard-v<version>-linux-amd64.tar.gz`
3. **Smoke-tests the archive**: unpacks it, starts the launcher and checks that it serves, loads pkarr and listens on loopback only
4. **Creates a GitHub Release** with auto-generated release notes, unless one already exists for the tag, and attaches the archive

The generated notes list the pull requests merged since the previous tag. `CHANGELOG.md` remains the written record. To use your own notes, create the release for the tag before the workflow finishes, or edit it afterwards; the workflow only attaches the archive to a release that exists.

## Post-Release Verification

- [ ] [GitHub Releases](https://github.com/pubky/homeserver-dashboard/releases) -- new release with the `linux-amd64` archive attached
- [ ] [Docker Hub](https://hub.docker.com/r/synonymsoft/homeserver-dashboard/tags) -- new tag visible, for both architectures
- [ ] The archive runs: download it as the [README](README.md#run-it-next-to-a-homeserver) describes, start it next to a homeserver and sign in
- [ ] The image runs: start it and open the Overview's "Pubky network" row. Nothing in CI starts the image, and the pkarr check fails only inside it

## Versioning

Follow [Semantic Versioning](https://semver.org/). While the version is 0.x:

- **Patch** (0.1.x): bug fixes, security updates and backwards-compatible features
- **Minor** (0.x.0): changes an operator has to act on, such as a renamed environment variable or a raised minimum homeserver version

The archive's Node.js version and checksum are pinned in `scripts/release-archive.sh`. Keep the version the one the Dockerfile's base image uses, and change both in the same PR.

## Hotfix Releases

For urgent patches that need to ship without merging into `main` first (for example when `main` has unreleased changes that are not ready):

### 1. Create a hotfix branch from the latest release tag

```bash
git checkout -b hotfix/v0.2.1 v0.2.0
```

### 2. Apply the fix and bump the version

Commit the fix on the hotfix branch, then bump the version and add the changelog section:

```bash
npm version 0.2.1 --no-git-tag-version
```

### 3. Tag and push

```bash
git push origin hotfix/v0.2.1
git tag v0.2.1
git push origin v0.2.1
```

### 4. Back-port to main

After the release, cherry-pick or merge the fix, the version bump and the changelog section into `main` so they are not lost:

```bash
git checkout main
git cherry-pick <commit-sha>
```

## Troubleshooting

**The archive workflow fails on "Check the tag against package.json"?** The tag is on a commit whose `package.json` has a different version, usually because the version PR was not merged first. The Docker workflow has no such check, so it has already published an image under that tag. Move the tag to the right commit as below; the Docker workflow runs again and overwrites the image.

**A workflow fails for another reason?** Fix the issue, then delete and re-push the tag. Both workflows run again: the image tag is overwritten and the archive is replaced on the release.

```bash
git tag -d v0.2.0
git push origin :refs/tags/v0.2.0
# fix the issue, commit, push to main
git tag v0.2.0
git push origin v0.2.0
```

If Umbrel or anyone else has already pinned the image by digest, release a new patch version instead of moving the tag.

**The smoke test fails?** Run it locally: `npm run bundle`, then `scripts/release-archive.sh <version> release` and `scripts/smoke-test-archive.sh <archive>`. It needs port 8080 free. A checksum failure in `release-archive.sh` means the pinned Node.js version and `NODE_SHA256` no longer match.

**Docker push fails?** Check that `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` are set and the token has not expired or lost write access to `synonymsoft/homeserver-dashboard`.
