# Changelog

**English** · [简体中文](./CHANGELOG.md)

This file records notable features, behavior changes, and fixes since the first release of
DSH Plugin Marketplace. It is reconstructed from Git tags and commit history; snapshot-only
Registry refresh commits are grouped instead of listed individually.

## [Unreleased]

No unreleased changes yet.

## [0.8.0] - 2026-08-15

### Added

- Added manual command installation under Management & diagnostics. It accepts the official
  `dsh plugin --profile <active-profile> add github:owner/repo[#ref]` form and the shorter
  `github:owner/repo[#ref]` form.
- Manual installs resolve tags, branches, and default sources to an exact commit, validate the DSH
  bundle, check conflicts, attach successful installs to the Profile, and list them under Installed
  plugins.

### Security

- Manual commands are parsed as structured data and never passed to a shell. Cross-Profile commands,
  extra arguments, multiple lines or commands, shell operators, and unsafe Git refs are rejected;
  lifecycle scripts remain disabled during installation.

### Tests

- Added parser regressions for valid formats, Profile isolation, and command injection. Typert Host
  callability coverage now includes all 14 Remote methods.

## [0.7.3] - 2026-08-15

### Changed

- Split the plugin area into Marketplace, Installed plugins, and Management & diagnostics pages.
  Plugin storage and conflict diagnosis now live on the dedicated management page, keeping the
  installed list focused.
- Added installed-plugin filtering by package name, description, repository, and version.
- Marketplace cards now use the repository name as the heading and show its author on a separate
  metadata line instead of combining both on one line.

## [0.7.2] - 2026-08-15

### Fixed

- Fixed `marketplace/installLocation` failing with “active Service has no callable method” when
  opening the marketplace. The Host implementation name now exactly matches its Typert Remote
  descriptor.

### Tests

- The Typert contract test now checks that every Remote descriptor resolves to a real callable
  method on the Host service, preventing similar implementation-name drift from shipping again.

## [0.7.1] - 2026-08-15

### Fixed

- Fixed installed plugins intermittently reappearing in `dsh.profile.bundles` after an install,
  update, or uninstall even though the user had disabled them.
- Profile plugin mutations are now globally serialized, including install-source resolution, so
  jobs for different packages cannot overwrite each other's dependencies or enabled state.
- Custom-directory installs and failure rollbacks now merge only the target dependency into the
  latest `package.json` instead of restoring a stale whole-file snapshot, preserving unrelated
  configuration changes made while a job is running.
- Bundle reconciliation is now target-scoped: newly installed bundles and dependencies that gain
  a bundle declaration are enabled, existing disabled bundles stay disabled, and uninstall removes
  only its own layer.
- The guided-install Agent now records the bundle order before invoking DSH or pnpm and preserves
  every existing plugin's enabled state, protecting users on DSH versions without the CLI fix.

### Tests

- Added regressions for disabled-state preservation, latest-manifest merging, cross-package job
  exclusion, and the guided Agent safety rule.

### Documentation

- Added complete Chinese and English changelogs covering `v0.1.0` through the current release,
  with links from both README files.

## [0.7.0] - 2026-08-15

### Added

- Added custom plugin install locations through DSH's native directory picker. External plugins
  are attached to the active Profile with a `file:` dependency and linked back into its
  `node_modules` for runtime loading.
- Added conflict diagnostics for duplicate Bundle IDs and common Cordis service registration
  forms. Install, update, and enable operations block only conflicts introduced by that operation.
- Added per-card install, update, and uninstall progress with collapsible logs and fixed-position
  failure notifications.
- Added read-only discovery of plugins present in a custom directory but not linked to the Profile.
- Added pull-request CI that builds real DSH type contracts and runs TypeScript, all test suites,
  plugin builds, manifest verification, and generated-artifact consistency checks.
- Added a real pnpm custom-directory integration suite covering lifecycle isolation, Host peer
  linking, `file:` specifications, and pnpm store reuse.

### Changed

- Install, update, and uninstall jobs now reuse the pnpm store already bound to the active Profile,
  reducing `ERR_PNPM_UNEXPECTED_STORE` failures.
- Changing the configured custom directory affects only future installs. Existing plugins remain
  updateable and removable at their original location.
- Scoped npm packages retain their `@scope/name` directory layout instead of being flattened.
- External installs link missing peers to the DSH Host and replace incorrectly auto-installed peer
  copies, preventing a second Cordis instance. Lifecycle scripts and peer auto-install are disabled
  while external dependencies are installed.
- Added promotional screenshots and documentation for install locations, conflict diagnostics,
  and their security boundaries.

### Fixed

- GitHub sources containing `preinstall`, `install`, `postinstall`, or `prepare` now always remain
  guided. A verified exact npm tarball with complete runtime artifacts may still be one-click.
- Fixed updates and uninstalls for existing external plugins after the configured directory changes.
- Fixed relative pnpm store paths resolving against the wrong working directory.
- Fixed invalid `file:` specifications for cross-drive Windows paths and Linux CI rewriting Windows
  absolute paths as relative paths.
- Fixed nullable TypeScript types for directory selection and job labels.
- Made strict-mode browser bundles deterministic across Windows and Linux.
- Upgraded cached Registry classifications without re-fetching unaffected entries, preventing a
  classifier migration from exhausting the API quota in one scan.

## [0.6.1] - 2026-08-15

### Changed

- Reworked the Chinese and English README files with a capability overview, installation modes,
  a Registry flowchart, security rules, and development guidance.
- Simplified marketplace card hierarchy, action layout, and information density for long
  descriptions and metadata.

## [0.6.0] - 2026-08-15

### Added

- Added constrained guided-install Agents for plugins and updates that cannot safely use one-click
  installation.
- Agent tasks pin the exact commit, package, Profile, scanner reasons, and acceptance checks, and
  require successful installs to explain the Profile, restart, configuration, and entry point.
- Published `registry/guided-audit.json` with per-scan evidence for every guided entry.

### Changed

- Increased Registry scan frequency from daily to every two hours.
- Added an optional read-only PAT through the `REGISTRY_GITHUB_TOKEN` Actions Secret, with fallback
  to `GITHUB_TOKEN`; Registry writes continue to use the built-in Actions credential.
- Guided entries and npm sources are revalidated every scan so newly valid npm releases can be
  promoted automatically to one-click installation.

## [0.5.0] - 2026-08-14

### Added

- Added direct marketplace self-update by reading the repository's current version and commit
  without waiting for a Registry refresh.
- Updates pin the resolved exact commit instead of passing mutable `main` to pnpm.
- Added self-update regression tests.

## [0.4.0] - 2026-08-14

### Added

- Published `registry/discovery.json` to provide categories without changing the core Registry v2
  format.
- Added category filters, a Recently Trending sort, and seven-day Star growth.
- Stored daily Star baselines in incremental state; new entries without history report zero growth.

### Fixed

- Partitioned oversized GitHub Search windows down to creation-time seconds to handle the
  1,000-result limit.
- Continued scans after Search API rate-limit resets instead of aborting large discovery runs.
- Retried transient GitHub README audit failures.
- Allowed Registry CI to verify generated data without a local DSH checkout.
- Retired an obsolete manual installation override.

## [0.3.3] - 2026-08-14

### Added

- Added a controlled Restart DSH action to Installed Plugins and restart-required notices.
- Restart waits for active plugin jobs, preserves the launch arguments and Profile, and refreshes
  the page after the service returns.
- Added restart-flow regression tests.

## [0.3.2] - 2026-08-14

### Changed

- Revalidated every guided entry and automatically resolved false positives that repository or npm
  evidence could prove safe.
- Added exact npm tarball verification for registry URL, SHA-512 integrity, package identity,
  bundle patch, runtime entries, lifecycle scripts, and root-level `binding.gyp`.
- Treated `<profile>`, `your-profile`, and `my-profile` as placeholders, and stopped interpreting
  example owners in README commands as real repository identities.
- Web client plugins default to `web`; host-only plugins default to `headless` and `web`.
- Preserved incorrect historical migration URLs as audit evidence without blocking a complete,
  installable exact commit in the current repository.
- Preserved the last verified result through transient GitHub or npm failures.
- Added `registry/guided-audit.json` and periodic npm-source revalidation.

> `v0.3.2` allowed some GitHub sources with `prepare` to install automatically. `v0.7.0` tightened
> this policy so every such GitHub source remains guided.

## [0.3.1] - 2026-08-14

### Fixed

- Reverted the `v0.3.0` packagePath/monorepo expansion and restored one marketplace entry per
  GitHub repository.
- Restored the public Registry v2 format, eliminating duplicate-looking cards for internal packages
  in aggregate repositories.
- Retained the installed-plugin enable/disable feature introduced in `v0.3.0`.

## [0.3.0] - 2026-08-14

### Added

- Added enable/disable controls for installed plugins by updating the active Profile's
  `dsh.profile.bundles` without removing dependencies.
- Added evidence-based install classification across manifests, README commands, runtime artifacts,
  Profiles, and lifecycle scripts.
- Added `registry/install-review.json` to preserve classification reasons and evidence requiring
  review.
- Briefly introduced `owner/repo&path:/subdirectory` identities and multi-plugin monorepo scanning.

### Fixed

- Added retries for transient remote Registry reads.
- Recognized more official DSH install command variants, Profile placeholders, and pnpm workspace
  flags.

> The packagePath/monorepo expansion treated many internal packages in aggregate repositories as
> standalone plugins and was reverted in `v0.3.1`. It is not current Registry behavior.

## [0.2.0] - 2026-08-14

### Added

- Extended Registry v2 with install source, compatible Profiles, build approval, restart, and manual
  step metadata.
- Added the Installed Plugins page with update checks, updates, and uninstalls for the active Profile.
- Enabled one-click installation only for exact, Profile-compatible sources that meet the safety
  policy; other entries show installation guidance.
- Added author-provided `dsh.marketplace` metadata and centrally reviewed install-policy overrides.

### Changed

- Added in-memory caching and ETag support for the remote Registry, with last-valid and bundled
  snapshot fallbacks.
- Simplified Registry maintenance documentation and removed an obsolete maintenance process.

## [0.1.0] - 2026-08-13

### Initial release

- Established the centrally and independently maintained DSH plugin Registry.
- Added a GitHub Action that discovers non-archived repositories carrying the `dsh-plugin` topic.
- Statically validated `package.json`, `dsh.bundle.patch`, YAML loader entries, and exact commits
  without installing dependencies or executing third-party code.
- Published verified plugins through `registry/plugins.json`, rejected candidates and reasons through
  `registry/rejected.json`, and incremental scan state through `registry/state.json`.
- Added the DSH Web marketplace with search, Star/update sorting, validation details, and exact
  commit installation.
- Bundled built artifacts and a Registry snapshot so the marketplace remains usable during remote
  Registry failures.
- Added the Registry Schema, scanner tests, build scripts, and validation against real DSH loaders.

[Unreleased]: https://github.com/YELEBAI/dsh-plugin-marketplace/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/YELEBAI/dsh-plugin-marketplace/compare/v0.7.3...v0.8.0
[0.7.3]: https://github.com/YELEBAI/dsh-plugin-marketplace/compare/v0.7.2...v0.7.3
[0.7.2]: https://github.com/YELEBAI/dsh-plugin-marketplace/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/YELEBAI/dsh-plugin-marketplace/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/YELEBAI/dsh-plugin-marketplace/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/YELEBAI/dsh-plugin-marketplace/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/YELEBAI/dsh-plugin-marketplace/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/YELEBAI/dsh-plugin-marketplace/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/YELEBAI/dsh-plugin-marketplace/compare/v0.3.3...v0.4.0
[0.3.3]: https://github.com/YELEBAI/dsh-plugin-marketplace/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/YELEBAI/dsh-plugin-marketplace/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/YELEBAI/dsh-plugin-marketplace/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/YELEBAI/dsh-plugin-marketplace/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/YELEBAI/dsh-plugin-marketplace/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/YELEBAI/dsh-plugin-marketplace/tree/v0.1.0
