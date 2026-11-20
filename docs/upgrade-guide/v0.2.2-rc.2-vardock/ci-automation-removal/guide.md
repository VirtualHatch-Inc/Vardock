---
kind: upgrade-guide
description: "The inherited GitHub Actions workflows, GitLab pipeline, repository automation, and CI-only `pnpm run` scripts are removed."
---

# CI automation removed

English | [中文](guide.zh.md)

## Change

The repository no longer contains `.github/workflows`, `.github/issue-management`, `.github/review-ownership`, `.github/preview-sizing`, `.github/dependabot.yml`, or `.gitlab-ci.yml`. No hosted CI, release, publication, signing, issue triage, review routing, or Dependabot run comes from this repository. These scripts no longer exist and fail with a missing-script error: `test:approval-policy`, `test:issue-management`, `check:ci` and every `check:ci:*` lane, `test:web:ci`, and `typecheck:contracts-ready`. The Desktop CI publication scripts and self-hosted runner scripts under `apps/desktop/scripts/` are removed; local packaging and upload commands are unchanged. Every gate that a removed lane ran remains under its local command, and gate commands no longer change behavior when `CI` or `GITHUB_ACTIONS` is set. The tracked-filename and package-metadata checks that only CI ran now run in `pnpm run hygiene` as `verify-expected-filenames` and `verify-package-meta`.

## Migration

1. Remove the scripts listed above from any local script or automation that calls them.
2. Run checks locally with the commands in [the development guide](../../../development.md); `pnpm run check:all` runs the comprehensive gate set, and `pnpm run test:bench` replaces `check:ci:bench`.
3. Confirm with `pnpm run hygiene` that the `expected filenames` and `package metadata` gates pass.
