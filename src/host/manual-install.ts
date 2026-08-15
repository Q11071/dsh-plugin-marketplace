/** Strict parser for the manual install field. Input is data, never shell code. */

export interface ManualGitHubInstall {
  repo: string
  ref: string
}

const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,38})'
const REPOSITORY = '[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})'
const GITHUB_SPEC = new RegExp('^github:(' + OWNER + ')\\/(' + REPOSITORY + ')(?:#([^#]+))?$')
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/

/**
 * Accept a bare github: spec or the exact documented DSH command shape.
 * Shell operators, extra flags, multiple commands, and cross-Profile writes
 * are rejected before any process can be spawned.
 */
export function parseManualInstall(command: string, activeProfile: string): ManualGitHubInstall {
  let value = command.trim()
  if (value.startsWith('`') && value.endsWith('`') && value.length > 2) value = value.slice(1, -1).trim()
  if (value === '' || /[\r\n]/.test(value)) throw new Error('Enter one DSH plugin install command on a single line.')

  let spec: string
  if (!/[ \t]/.test(value)) {
    spec = unquote(value)
  } else {
    const tokens = value.split(/[ \t]+/).map(unquote)
    if (tokens.length === 6
      && tokens[0] === 'dsh'
      && tokens[1] === 'plugin'
      && tokens[2] === '--profile'
      && tokens[4] === 'add') {
      if (tokens[3] !== activeProfile) throw new Error('The command Profile must match the current Profile: ' + activeProfile + '.')
      spec = tokens[5] as string
    } else if (tokens.length === 5
      && tokens[0] === 'dsh'
      && tokens[1] === 'plugin'
      && tokens[2]?.startsWith('--profile=') === true
      && tokens[3] === 'add') {
      if (tokens[2]?.slice('--profile='.length) !== activeProfile) throw new Error('The command Profile must match the current Profile: ' + activeProfile + '.')
      spec = tokens[4] as string
    } else {
      throw new Error('Only `dsh plugin --profile <current> add github:owner/repo[#ref]` is accepted.')
    }
  }

  const match = GITHUB_SPEC.exec(spec)
  if (match === null) throw new Error('Only a GitHub source in the form github:owner/repo[#ref] is accepted.')
  const ref = match[3] ?? ''
  if (ref !== '' && (!SAFE_REF.test(ref) || ref.includes('..') || ref.includes('//') || ref.endsWith('/') || ref.endsWith('.lock'))) {
    throw new Error('The GitHub ref contains unsupported characters or segments.')
  }
  return { repo: (match[1] as string) + '/' + (match[2] as string), ref }
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1)
  }
  return value
}
