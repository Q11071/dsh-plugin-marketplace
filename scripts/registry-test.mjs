/** Regression tests for the static Registry validator. */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  InvalidCandidateError,
  classifyInstall,
  encodeRawPath,
  safePatchPath,
  validateBundlePatch,
  validateManifest,
  verifiedPlugin,
} from './registry-core.mjs'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

const identity = validateManifest(await readFile(path.join(root, 'package.json'), 'utf8'))
assert.equal(identity.packageName, 'dsh-plugin-marketplace')
assert.equal(identity.bundlePatch, './cordis.patch.yml')
assert.equal(identity.hasClient, true)
assert.deepEqual(identity.installHints.lifecycleScripts, [])
assert.equal(identity.installHints.declaredProfiles, undefined)
assert.deepEqual(identity.installHints.runtimeEntryGroups.map(group => group.label), ['host', 'client'])
validateBundlePatch(await readFile(path.join(root, 'cordis.patch.yml'), 'utf8'), identity.packageName)

assert.equal(safePatchPath('./nested/plugin.yml'), true)
assert.equal(safePatchPath('../outside.yml'), false)
assert.equal(safePatchPath('C:/outside.yml'), false)
assert.equal(encodeRawPath('./nested/plugin.yml'), 'nested/plugin.yml')

assertInvalid(
  () => validateManifest('{"name":"bad","version":"1.0.0"}'),
  'manifest without dsh.bundle.patch',
)
assertInvalid(
  () => validateManifest('{"name":"bad","version":"1.0.0","dsh":{"bundle":{"patch":"./p.yml"},"marketplace":{"profiles":["Bad Profile"]}}}'),
  'manifest with malformed marketplace profiles',
)

const marketplaceClassification = classifyInstall(
  identity,
  'owner/repo',
  ['lib/index.js', 'lib/client.js'],
  'dsh plugin --profile web add github:owner/repo',
)
const row = verifiedPlugin({
  full_name: 'owner/repo',
  name: 'repo',
  default_branch: 'main',
  html_url: 'https://github.com/owner/repo',
  updated_at: '2026-08-13T00:00:00Z',
  owner: { login: 'owner' },
}, 'a'.repeat(40), marketplaceClassification.identity, '2026-08-13T00:00:00Z')
assert.equal(row.install.mode, 'automatic')
assert.equal(row.install.spec, 'github:owner/repo#' + 'a'.repeat(40))
assert.deepEqual(row.install.profiles, ['web'])

const npmClassification = classifyInstall(
  identity,
  'owner/repo',
  ['lib/index.js', 'lib/client.js'],
  'dsh plugin --profile web add dsh-plugin-marketplace',
)
assert.equal(npmClassification.inspection.readme.directNpm, true)
const npmRow = verifiedPlugin({
  full_name: 'owner/repo',
  name: 'repo',
  default_branch: 'main',
  html_url: 'https://github.com/owner/repo',
  updated_at: '2026-08-13T00:00:00Z',
  owner: { login: 'owner' },
}, 'b'.repeat(40), npmClassification.identity, '2026-08-13T00:00:00Z', {
  source: 'npm',
  spec: 'dsh-plugin-marketplace@' + identity.version,
  profiles: ['web'],
  requiresBuildApproval: false,
  manualSteps: false,
})
assert.equal(npmRow.install.mode, 'automatic')
assert.equal(npmRow.install.source, 'npm')

const prepareManifest = validateManifest(JSON.stringify({
  name: '@dsh-external/dsh-side-panel',
  version: '0.2.0',
  main: './lib/index.js',
  exports: { '.': './lib/index.js', './client': './lib/client.js' },
  scripts: { prepare: 'npm run build' },
  dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
}))
const preparePrebuilt = classifyInstall(
  prepareManifest,
  'ccq1/dsh-side-panel',
  ['lib/index.js', 'lib/client.js', 'README.md'],
  'dsh plugin --profile web add github:dsh-external/dsh-side-panel',
  ['ccq1/dsh-side-panel', 'dsh-external/dsh-side-panel'],
)
assert.equal(preparePrebuilt.identity.installHints.requiresBuildApproval, false)
assert.equal(preparePrebuilt.identity.installHints.manualSteps, false)
assert.equal(preparePrebuilt.inspection.runtimeArtifactsCommitted, true)
assert.equal(preparePrebuilt.inspection.readme.directGitHub, true)
assert.deepEqual(preparePrebuilt.inspection.resolvedReasons, [
  'prepare-present-but-author-documented-github-install-and-runtime-artifacts-are-committed',
])

const sameNameDifferentRepository = classifyInstall(
  prepareManifest,
  'ccq1/dsh-side-panel',
  ['lib/index.js', 'lib/client.js'],
  'dsh plugin --profile web add github:unverified-owner/dsh-side-panel',
)
assert.equal(sameNameDifferentRepository.inspection.readme.directGitHub, false)
assert.equal(sameNameDifferentRepository.identity.installHints.requiresBuildApproval, true)
assert.deepEqual(sameNameDifferentRepository.inspection.readme.unverifiedGitHubRepositories, [
  'unverified-owner/dsh-side-panel',
])
assert.ok(sameNameDifferentRepository.inspection.reviewReasons.includes(
  'readme-github-repository-owner-does-not-resolve-to-this-candidate',
))

const unverifiedOwnerOnly = classifyInstall(
  identity,
  'owner/repo',
  ['lib/index.js', 'lib/client.js'],
  'dsh plugin --profile web add github:unverified-owner/repo',
)
assert.equal(unverifiedOwnerOnly.identity.installHints.requiresBuildApproval, false)
assert.equal(unverifiedOwnerOnly.identity.installHints.manualSteps, false)
assert.deepEqual(unverifiedOwnerOnly.inspection.resolvedReasons, [
  'readme-alias-is-unverified-but-exact-current-repository-install-is-self-contained',
])

const anyProfile = classifyInstall(
  validateManifest(JSON.stringify({
    name: 'any-profile-plugin',
    version: '1.0.0',
    main: './index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })),
  'owner/any-profile-plugin',
  ['index.js'],
  'dsh plugin --profile <profile> add github:owner/any-profile-plugin',
)
assert.equal(anyProfile.inspection.readme.anyProfile, true)
assert.deepEqual(anyProfile.identity.installHints.profiles, ['headless', 'web'])
assert.equal(anyProfile.identity.installHints.manualSteps, false)

const prosePlaceholder = classifyInstall(
  validateManifest(JSON.stringify({
    name: 'prose-placeholder-plugin',
    version: '1.0.0',
    main: './index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })),
  'owner/prose-placeholder-plugin',
  ['index.js'],
  'dsh plugin --profile your-profile add prose-placeholder-plugin',
)
assert.equal(prosePlaceholder.inspection.readme.anyProfile, true)
assert.deepEqual(prosePlaceholder.identity.installHints.profiles, ['headless', 'web'])

const hostWithoutProfileDocs = classifyInstall(
  validateManifest(JSON.stringify({
    name: 'host-without-profile-docs',
    version: '1.0.0',
    main: './index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })),
  'owner/host-without-profile-docs',
  ['index.js'],
  null,
)
assert.deepEqual(hostWithoutProfileDocs.identity.installHints.profiles, ['headless', 'web'])
assert.equal(hostWithoutProfileDocs.identity.installHints.manualSteps, false)

const workspaceRootOption = classifyInstall(
  identity,
  'owner/repo',
  ['lib/index.js', 'lib/client.js'],
  'dsh plugin --profile web add -w github:owner/repo#<reviewed-commit>',
)
assert.equal(workspaceRootOption.inspection.readme.directGitHub, true)
assert.deepEqual(workspaceRootOption.identity.installHints.profiles, ['web'])
assert.equal(workspaceRootOption.identity.installHints.manualSteps, false)

const missingRequiredProfile = classifyInstall(
  identity,
  'owner/repo',
  ['lib/index.js', 'lib/client.js'],
  'dsh plugin add github:owner/repo',
)
assert.equal(missingRequiredProfile.inspection.readme.directGitHub, false)
assert.equal(missingRequiredProfile.identity.installHints.manualSteps, false)
assert.deepEqual(missingRequiredProfile.identity.installHints.profiles, ['web'])

const placeholderOwner = classifyInstall(
  identity,
  'owner/repo',
  ['lib/index.js', 'lib/client.js'],
  'dsh plugin --profile <profile> add github:you/repo',
)
assert.equal(placeholderOwner.inspection.readme.directGitHub, false)
assert.equal(placeholderOwner.identity.installHints.manualSteps, false)
assert.deepEqual(placeholderOwner.inspection.readme.unverifiedGitHubRepositories, [])

const documentedBuildApproval = classifyInstall(
  prepareManifest,
  'ccq1/dsh-side-panel',
  ['lib/index.js', 'lib/client.js'],
  'dsh plugin --profile web add github:ccq1/dsh-side-panel\nAdd it to allowBuilds before installing.',
)
assert.equal(documentedBuildApproval.identity.installHints.requiresBuildApproval, true)
assert.equal(documentedBuildApproval.identity.installHints.manualSteps, true)

const prepareUndocumented = classifyInstall(
  prepareManifest,
  'ccq1/dsh-side-panel',
  ['lib/index.js', 'lib/client.js'],
  null,
)
assert.equal(prepareUndocumented.identity.installHints.requiresBuildApproval, true)
assert.equal(prepareUndocumented.inspection.reviewReasons.length, 1)

const prepareMissing = classifyInstall(
  prepareManifest,
  'ccq1/dsh-side-panel',
  ['README.md'],
  'dsh plugin --profile web add github:dsh-external/dsh-side-panel',
  ['ccq1/dsh-side-panel', 'dsh-external/dsh-side-panel'],
)
assert.equal(prepareMissing.identity.installHints.requiresBuildApproval, true)
assert.equal(prepareMissing.inspection.reviewReasons[0], 'readme-documents-github-install-but-runtime-entry-artifacts-are-missing')

const hardLifecycle = validateManifest(JSON.stringify({
  name: 'hard-lifecycle',
  version: '1.0.0',
  main: './index.js',
  scripts: { postinstall: 'node setup.js' },
  dsh: { bundle: { patch: './cordis.patch.yml' }, marketplace: { profiles: ['web'] } },
}))
const hardClassification = classifyInstall(
  hardLifecycle,
  'owner/hard-lifecycle',
  ['index.js'],
  'dsh plugin --profile web add github:owner/hard-lifecycle',
)
assert.equal(hardClassification.identity.installHints.requiresBuildApproval, true)
assertInvalid(
  () => validateBundlePatch('- insert:\n    - id: wrong\n      name: another-package\n', identity.packageName),
  'patch without an owning loader entry',
)

globalThis.__DSH_REGISTRY_EXECUTED__ = false
validateBundlePatch(
  '- insert:\n'
  + '    - id: safe-static-data\n'
  + '      name: dsh-plugin-marketplace\n'
  + '      config: !!js globalThis.__DSH_REGISTRY_EXECUTED__ = true\n',
  identity.packageName,
)
assert.equal(globalThis.__DSH_REGISTRY_EXECUTED__, false, 'YAML !!js content must never execute during validation')
delete globalThis.__DSH_REGISTRY_EXECUTED__

console.log('Registry validator tests passed')

function assertInvalid(callback, label) {
  assert.throws(callback, error => error instanceof InvalidCandidateError, label)
}
