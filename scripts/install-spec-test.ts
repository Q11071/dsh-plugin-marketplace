/** Regression tests for verified install-source validation and public GitHub transport. */

import assert from 'node:assert/strict'
import { githubArchiveSpec } from '../src/host/install-spec.ts'

const commit = '315d905d2cfc177885117d5187b8587bdc2b2f3f'
assert.equal(
  githubArchiveSpec('Lstalu/dsh-quota-meter-plus', commit),
  'https://codeload.github.com/Lstalu/dsh-quota-meter-plus/tar.gz/' + commit,
)
assert.throws(() => githubArchiveSpec('owner/repo/extra', commit), /Invalid GitHub repository/)
assert.throws(() => githubArchiveSpec('owner/repo', 'main'), /Invalid GitHub commit/)

console.log('Executable install spec tests passed')
