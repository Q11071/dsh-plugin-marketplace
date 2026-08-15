/** Load the packaged guided-install Skill for global DSH Agent discovery. */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const INSTALL_SKILL_NAME = 'install-dsh-plugin'

export interface MarketplaceSkillRegistration {
  name: string
  description: string
  source: 'runtime'
  provider: 'marketplace'
  path: string
  resourceBase: { kind: 'directory'; path: string }
  invocation: { modelInvocable: true; userInvocable: true }
  content: string
}

/** Resolve both the TypeScript checkout and the built package layout. */
export function loadInstallSkill(): MarketplaceSkillRegistration {
  const candidates = [
    fileURLToPath(new URL('../../skills/install-dsh-plugin/SKILL.md', import.meta.url)),
    fileURLToPath(new URL('../skills/install-dsh-plugin/SKILL.md', import.meta.url)),
  ]
  const path = candidates.find(existsSync)
  if (path === undefined) throw new Error('Packaged Skill is missing: skills/install-dsh-plugin/SKILL.md')
  const source = readFileSync(path, 'utf8')
  const match = /^---\r?\nname:\s*([^\r\n]+)\r?\ndescription:\s*([^\r\n]+)\r?\n---\r?\n([\s\S]*)$/.exec(source)
  if (match === null) throw new Error('Packaged Skill frontmatter is invalid.')
  const name = match[1]!.trim()
  const description = match[2]!.trim()
  if (name !== INSTALL_SKILL_NAME || description === '' || match[3]!.trim() === '') {
    throw new Error('Packaged Skill identity or body is invalid.')
  }
  const directory = dirname(path)
  return {
    name,
    description,
    source: 'runtime',
    provider: 'marketplace',
    path,
    resourceBase: { kind: 'directory', path: resolve(directory) },
    invocation: { modelInvocable: true, userInvocable: true },
    content: match[3]!.trim(),
  }
}
