/** Deterministic discovery metadata: categories and bounded Star history. */

const DAY_MS = 86_400_000

export const PLUGIN_CATEGORIES = Object.freeze([
  'ui',
  'agents',
  'developer-tools',
  'models',
  'data',
  'integrations',
  'media',
  'security',
  'observability',
  'other',
])

const CATEGORY_RULES = [
  ['ui', ['ui', 'theme', 'skin', 'sidebar', 'side-panel', 'panel', 'dashboard', 'view', 'layout', 'navigation', 'nav', 'shortcut', 'frontend', 'mobile-ui', 'tui']],
  ['agents', ['agent', 'workflow', 'orchestrat', 'automation', 'auto-continue', 'scheduler', 'schedule', 'task', 'planner', 'subagent', 'copilot']],
  ['developer-tools', ['developer', 'devtool', 'code', 'git', 'repo', 'workspace', 'terminal', 'shell', 'debug', 'test', 'playwright', 'browser', 'project', 'file', 'open-with']],
  ['models', ['llm', 'model', 'provider', 'router', 'fallback', 'openai', 'codex', 'claude', 'qwen', 'xai', 'gemini', 'ollama']],
  ['data', ['data', 'database', 'memory', 'knowledge', 'graph', 'document', 'pdf', 'research', 'search', 'rag', 'vector', 'context']],
  ['integrations', ['integration', 'mcp', 'lark', 'dingtalk', 'wecom', 'weixin', 'wechat', 'qqbot', 'telegram', 'slack', 'discord', 'channel', 'webhook', 'bridge', 'sync', 'api']],
  ['media', ['media', 'image', 'vision', 'video', 'audio', 'music', 'sound', 'multimodal', 'figma', 'lottie', 'mermaid', 'latex']],
  ['security', ['security', 'guard', 'audit', 'approval', 'policy', 'permission', 'auth', 'vault', 'redact', 'privacy', 'checksum', 'evidence', 'receipt', 'sentinel']],
  ['observability', ['observability', 'analytics', 'metric', 'stats', 'usage', 'cost', 'token', 'telemetry', 'monitor', 'trace', 'report', 'budget', 'billing']],
]

/** Return up to three ranked categories from repository-owned public metadata. */
export function classifyPluginCategories(plugin) {
  const topics = searchable(Array.isArray(plugin?.topics) ? plugin.topics.join(' ') : '')
  const identity = searchable([
    typeof plugin?.fullName === 'string' ? plugin.fullName : '',
    typeof plugin?.packageName === 'string' ? plugin.packageName : '',
    typeof plugin?.repo === 'string' ? plugin.repo : '',
  ].join(' '))
  const description = searchable(typeof plugin?.description === 'string' ? plugin.description : '')
  const ranked = CATEGORY_RULES.map(([category, keywords], order) => ({
    category,
    order,
    score: (matches(topics, keywords) ? 5 : 0)
      + (matches(identity, keywords) ? 3 : 0)
      + (matches(description, keywords) ? 1 : 0),
  }))
    .filter(row => row.score > 0)
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .slice(0, 3)
    .map(row => row.category)
  return ranked.length > 0 ? ranked : ['other']
}

/**
 * Keep one baseline sample per UTC date for the current date plus seven days.
 * A second scan on the same date preserves that day's earliest count, so Star
 * gains accrued between manual scans remain visible.
 */
export function updateStarHistory(previousHistory, previousStars, previousGeneratedAt, currentStars, generatedAt) {
  const currentDate = isoDate(generatedAt)
  if (currentDate === null) throw new Error('generatedAt must be an ISO date')
  const byDate = new Map()
  if (Array.isArray(previousHistory)) {
    for (const sample of previousHistory) {
      const date = typeof sample?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sample.date) ? sample.date : null
      const stars = nonnegativeInteger(sample?.stars)
      if (date !== null && stars !== null && !byDate.has(date)) byDate.set(date, stars)
    }
  }
  const previousDate = isoDate(previousGeneratedAt)
  const previousCount = nonnegativeInteger(previousStars)
  if (byDate.size === 0 && previousDate !== null && previousCount !== null) {
    byDate.set(previousDate, previousCount)
  }
  const currentCount = nonnegativeInteger(currentStars) ?? 0
  if (!byDate.has(currentDate)) byDate.set(currentDate, currentCount)
  const cutoff = new Date(Date.parse(currentDate + 'T00:00:00.000Z') - 7 * DAY_MS).toISOString().slice(0, 10)
  return [...byDate.entries()]
    .filter(([date]) => date >= cutoff && date <= currentDate)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, stars]) => ({ date, stars }))
}

/** Positive Star gain from the oldest retained baseline to the current count. */
export function starGrowth7d(history, currentStars) {
  const current = nonnegativeInteger(currentStars) ?? 0
  const baseline = Array.isArray(history) ? nonnegativeInteger(history[0]?.stars) : null
  return baseline === null ? 0 : Math.max(0, current - baseline)
}

function searchable(value) {
  const text = value.toLocaleLowerCase()
  return { text, tokens: new Set(text.split(/[^a-z0-9]+/).filter(Boolean)) }
}

function matches(search, keywords) {
  return keywords.some(keyword => keyword.length <= 3
    ? search.tokens.has(keyword)
    : search.text.includes(keyword))
}

function isoDate(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null
  return new Date(value).toISOString().slice(0, 10)
}

function nonnegativeInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}
