/** Shared policy for incremental, exact-commit plugin security scans. */

export const SECURITY_POLICY_VERSION = 1
export const SECURITY_REASON_PENDING = 'security-scan-pending-for-exact-commit'
export const SECURITY_REASON_REVIEW = 'security-scan-requires-manual-review'
export const SECURITY_REASON_RETRY = 'security-scan-could-not-complete'

export const SECURITY_FINDING_RULES = new Set([
  'bundled-native-executable',
  'credential-access-with-network',
  'crypto-miner-indicator',
  'destructive-system-command',
  'download-and-execute-primitives',
  'dynamic-code-execution',
  'encoded-payload-execution',
  'install-lifecycle-script',
  'persistence-installation',
  'process-spawn',
  'reverse-shell-indicator',
  'sensitive-credential-access',
])

const SOURCE_EXTENSIONS = new Set([
  '.cjs', '.cmd', '.js', '.jsx', '.mjs', '.ps1', '.sh', '.ts', '.tsx',
])
const SECURITY_REASONS = new Set([
  SECURITY_REASON_PENDING,
  SECURITY_REASON_REVIEW,
  SECURITY_REASON_RETRY,
])

/** Select exact commits which do not already have a reusable result. */
export function planSecurityScan(registry, report, limit = 100, batchSize = 5) {
  if (!plainObject(registry) || !Array.isArray(registry.plugins)) throw new Error('Registry root is invalid')
  if (!validSecurityReportRoot(report)) throw new Error('security report root is invalid')
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('security scan limit must be between 1 and 500')
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 20) throw new Error('security batch size must be between 1 and 20')

  const existing = new Map(report.results.map(row => [row.repository.toLocaleLowerCase(), row]))
  const queued = []
  for (const plugin of registry.plugins) {
    if (!validPluginIdentity(plugin)) continue
    const previous = existing.get(plugin.fullName.toLocaleLowerCase())
    let priority
    if (previous === undefined) {
      priority = Date.parse(plugin.verifiedAt) >= Date.parse(report.enforcementStartedAt) ? 1 : 3
    } else if (previous.verifiedCommit !== plugin.verifiedCommit) {
      priority = 0
    } else if (previous.status === 'error') {
      priority = 2
    } else {
      continue
    }
    queued.push({
      repository: plugin.fullName,
      verifiedCommit: plugin.verifiedCommit,
      priority,
    })
  }
  queued.sort((left, right) => left.priority - right.priority || left.repository.localeCompare(right.repository))
  const selected = queued.slice(0, limit).map(({ priority: _priority, ...row }) => row)
  const batches = []
  for (let index = 0; index < selected.length; index += batchSize) {
    batches.push({ id: Math.floor(index / batchSize), repositories: selected.slice(index, index + batchSize) })
  }
  return { selected, batches, remaining: Math.max(0, queued.length - selected.length) }
}

/**
 * Return the conservative install gate for a plugin at its exact commit.
 * Commits that pre-date enforcement are allowed while the initial backfill runs.
 */
export function securityGateReason(plugin, report) {
  if (!validSecurityReportRoot(report) || !validPluginIdentity(plugin)) return null
  const result = report.results.find(row => row.repository.toLocaleLowerCase() === plugin.fullName.toLocaleLowerCase())
  if (result !== undefined && result.verifiedCommit === plugin.verifiedCommit) {
    if (result.status === 'review') return SECURITY_REASON_REVIEW
    if (result.status === 'error') return SECURITY_REASON_RETRY
    return null
  }
  if (result !== undefined) return SECURITY_REASON_PENDING
  return Date.parse(plugin.verifiedAt) >= Date.parse(report.enforcementStartedAt)
    ? SECURITY_REASON_PENDING
    : null
}

/** Apply a security result without discarding the classifier's original evidence. */
export function applySecurityGate(stateRow, report) {
  if (!plainObject(stateRow?.plugin) || !plainObject(stateRow?.inspection)) return stateRow
  const reason = securityGateReason(stateRow.plugin, report)
  const previousReasons = Array.isArray(stateRow.inspection.reviewReasons)
    ? stateRow.inspection.reviewReasons.filter(value => !SECURITY_REASONS.has(value))
    : []
  if (reason === null) {
    if (previousReasons.length === stateRow.inspection.reviewReasons.length) return stateRow
    return {
      ...stateRow,
      inspection: { ...stateRow.inspection, reviewReasons: previousReasons },
    }
  }
  return {
    ...stateRow,
    plugin: {
      ...stateRow.plugin,
      install: {
        ...stateRow.plugin.install,
        mode: 'guided',
        manualSteps: true,
      },
    },
    inspection: {
      ...stateRow.inspection,
      reviewReasons: [...new Set([...previousReasons, reason])],
    },
  }
}

export function isSecurityReviewReason(value) {
  return SECURITY_REASONS.has(value)
}

/** Scan bounded source buffers. This function never evaluates plugin code. */
export function analyzePluginFiles(files, manifest = undefined) {
  const findings = []
  let scannedFiles = 0
  let scannedBytes = 0
  for (const file of files) {
    if (!plainObject(file) || typeof file.path !== 'string' || !Buffer.isBuffer(file.bytes)) continue
    scannedFiles += 1
    scannedBytes += file.bytes.length
    if (nativeExecutable(file.path, file.bytes)) {
      addFinding(findings, 'bundled-native-executable', 'high', file.path, 1)
      continue
    }
    if (!SOURCE_EXTENSIONS.has(extension(file.path))) continue
    const text = file.bytes.toString('utf8')
    const signals = sourceSignals(text)
    if (signals.destructive) addFinding(findings, 'destructive-system-command', 'critical', file.path, lineOf(text, signals.destructive.index))
    if (signals.reverseShell) addFinding(findings, 'reverse-shell-indicator', 'critical', file.path, lineOf(text, signals.reverseShell.index))
    if (signals.miner) addFinding(findings, 'crypto-miner-indicator', 'critical', file.path, lineOf(text, signals.miner.index))
    if (signals.persistence) addFinding(findings, 'persistence-installation', 'high', file.path, lineOf(text, signals.persistence.index))
    if (signals.encodedExecution) addFinding(findings, 'encoded-payload-execution', 'high', file.path, lineOf(text, signals.encodedExecution.index))
    if (signals.credentials) addFinding(findings, 'sensitive-credential-access', 'medium', file.path, lineOf(text, signals.credentials.index))
    if (signals.dynamic) addFinding(findings, 'dynamic-code-execution', 'medium', file.path, lineOf(text, signals.dynamic.index))
    if (signals.process) addFinding(findings, 'process-spawn', 'medium', file.path, lineOf(text, signals.process.index))
    if (signals.credentials && signals.network) {
      addFinding(findings, 'credential-access-with-network', 'high', file.path, lineOf(text, Math.min(signals.credentials.index, signals.network.index)))
    }
    if (signals.process && signals.network) {
      addFinding(findings, 'download-and-execute-primitives', 'high', file.path, lineOf(text, Math.min(signals.process.index, signals.network.index)))
    }
  }

  if (plainObject(manifest?.scripts)) {
    for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) {
      if (typeof manifest.scripts[name] === 'string') {
        addFinding(findings, 'install-lifecycle-script', 'low', 'package.json', 1, name)
      }
    }
  }
  const bounded = findings.slice(0, 64)
  const riskScore = Math.min(100, bounded.reduce((sum, finding) => sum + severityScore(finding.severity), 0))
  const review = bounded.some(finding => finding.severity === 'critical' || finding.severity === 'high')
  return {
    status: review ? 'review' : 'passed',
    riskScore,
    scannedFiles,
    scannedBytes,
    findings: bounded,
    truncatedFindings: findings.length > bounded.length,
  }
}

export function validSecurityReportRoot(value) {
  return plainObject(value)
    && value.schemaVersion === 1
    && value.policyVersion === SECURITY_POLICY_VERSION
    && !Number.isNaN(Date.parse(value.generatedAt))
    && !Number.isNaN(Date.parse(value.enforcementStartedAt))
    && Array.isArray(value.results)
}

export function validSecurityResult(value) {
  return plainObject(value)
    && typeof value.repository === 'string'
    && /^[\w.-]+\/[\w.-]+$/.test(value.repository)
    && /^[0-9a-f]{40}$/i.test(value.verifiedCommit ?? '')
    && typeof value.packageName === 'string'
    && typeof value.version === 'string'
    && !Number.isNaN(Date.parse(value.scannedAt))
    && ['passed', 'review', 'error'].includes(value.status)
    && Number.isInteger(value.riskScore)
    && value.riskScore >= 0
    && value.riskScore <= 100
    && plainObject(value.static)
    && Number.isInteger(value.static.scannedFiles)
    && Number.isInteger(value.static.scannedBytes)
    && Array.isArray(value.static.findings)
    && value.static.findings.length <= 64
    && value.static.findings.every(validFinding)
    && plainObject(value.sandbox)
    && ['passed', 'inconclusive', 'failed', 'skipped', 'unavailable'].includes(value.sandbox.status)
    && typeof value.sandbox.reason === 'string'
}

function validFinding(value) {
  return plainObject(value)
    && SECURITY_FINDING_RULES.has(value.rule)
    && ['low', 'medium', 'high', 'critical'].includes(value.severity)
    && typeof value.path === 'string'
    && value.path.length <= 500
    && Number.isInteger(value.line)
    && value.line >= 1
    && (value.detail === undefined || (typeof value.detail === 'string' && value.detail.length <= 100))
}

function validPluginIdentity(plugin) {
  return plainObject(plugin)
    && typeof plugin.fullName === 'string'
    && /^[\w.-]+\/[\w.-]+$/.test(plugin.fullName)
    && /^[0-9a-f]{40}$/i.test(plugin.verifiedCommit ?? '')
    && !Number.isNaN(Date.parse(plugin.verifiedAt))
}

function sourceSignals(text) {
  return {
    destructive: firstMatch(text, /\brm\s+-[^\r\n]*r[^\r\n]*f[^\r\n]*(?:\/|~|\$HOME)\b|\bRemove-Item\b[^\r\n]*(?:-Recurse[^\r\n]*-Force|-Force[^\r\n]*-Recurse)[^\r\n]*(?:[A-Za-z]:\\|\$HOME)|\bformat\s+[A-Za-z]:/iu),
    reverseShell: firstMatch(text, /\/dev\/tcp\/|\bnc\s+[^\r\n]*\s-e\s|\bbash\s+-i\b|\bIEX\s*\([^\r\n]*(?:DownloadString|Invoke-WebRequest)/iu),
    miner: firstMatch(text, /stratum\+(?:tcp|ssl):\/\/|\bxmrig\b|\bminerd\b|cryptonight/iu),
    persistence: firstMatch(text, /\bcrontab\b|\.config\/autostart|\/etc\/systemd\/system|CurrentVersion\\Run\b|\bschtasks(?:\.exe)?\b[^\r\n]*\/create/iu),
    encodedExecution: firstMatch(text, /(?:eval|Function)\s*\([^\r\n]{0,160}(?:atob\s*\(|Buffer\.from\s*\([^\r\n]{0,120}base64)|\b(?:[A-Za-z0-9+/]{256,}={0,2})\b/iu),
    credentials: firstMatch(text, /(?:\.ssh[\\/]|\.aws[\\/]credentials|\.npmrc\b|\.git-credentials\b|GITHUB_TOKEN\b|NPM_TOKEN\b|AWS_SECRET_ACCESS_KEY\b|OPENAI_API_KEY\b|DSH_\w*(?:TOKEN|SECRET|KEY)\b)/u),
    dynamic: firstMatch(text, /\beval\s*\(|\bnew\s+Function\s*\(|\bvm\.(?:runIn|compileFunction)/u),
    process: firstMatch(text, /(?:node:)?child_process|\b(?:exec|execFile|spawn|fork|system)Sync?\s*\(/u),
    network: firstMatch(text, /\bfetch\s*\(|\baxios\s*[.(]|\bhttps?\.(?:request|get)\s*\(|\bWebSocket\s*\(|\bnet\.connect\s*\(/u),
  }
}

function firstMatch(text, expression) {
  const match = expression.exec(text)
  return match === null ? null : { index: match.index }
}

function nativeExecutable(filePath, bytes) {
  const ext = extension(filePath)
  if (['.dll', '.dylib', '.exe', '.node', '.so'].includes(ext)) return true
  if (bytes.length < 4) return false
  return (bytes[0] === 0x4d && bytes[1] === 0x5a)
    || (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46)
    || ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(bytes.readUInt32BE(0)))
}

function addFinding(findings, rule, severity, filePath, line, detail = undefined) {
  if (findings.some(item => item.rule === rule && item.path === filePath)) return
  findings.push({ rule, severity, path: filePath.slice(0, 500), line, ...(detail === undefined ? {} : { detail }) })
}

function severityScore(value) {
  if (value === 'critical') return 100
  if (value === 'high') return 40
  if (value === 'medium') return 10
  return 2
}

function lineOf(text, index) {
  return text.slice(0, Math.max(0, index)).split('\n').length
}

function extension(value) {
  const name = String(value).toLocaleLowerCase()
  const index = name.lastIndexOf('.')
  return index < 0 ? '' : name.slice(index)
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
