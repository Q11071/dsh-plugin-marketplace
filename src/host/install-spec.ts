/** Build the immutable HTTPS transport used after Registry source validation. */

const REPOSITORY_PATTERN = /^([\w.-]+)\/([\w.-]+)$/

function parseRepository(value: string): { owner: string; repo: string } {
  const match = REPOSITORY_PATTERN.exec(value)
  if (match === null) {
    throw new Error('Invalid GitHub repository in the verified Registry: ' + value)
  }
  return { owner: match[1]!, repo: match[2]! }
}

export function githubArchiveSpec(fullName: string, verifiedCommit: string): string {
  const { owner, repo } = parseRepository(fullName)
  if (!/^[0-9a-f]{40}$/i.test(verifiedCommit)) {
    throw new Error('Invalid GitHub commit in the verified Registry: ' + verifiedCommit)
  }
  // pnpm resolves the `github:` shorthand through SSH on some Windows setups and
  // even normalizes a git+https input back to that shorthand in package.json.
  // A commit-pinned archive stays HTTPS in both the manifest and lockfile.
  return 'https://codeload.github.com/' + owner + '/' + repo + '/tar.gz/' + verifiedCommit
}
