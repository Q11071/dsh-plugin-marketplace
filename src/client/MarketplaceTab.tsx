import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  IconChevronDownOutline14,
  IconSearchOutline16,
  Input,
  Pill,
  RiskConfirmation,
  StateDot,
  type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  MarketplaceConflict,
  MarketplaceDiagnoseConflictsResult,
  MarketplaceInstalled,
  MarketplaceInstalledEntry,
  MarketplaceInstallLocation,
  MarketplaceJobKind,
  MarketplaceJobStatus,
  MarketplaceManualInstallResult,
  MarketplacePluginDetails,
  MarketplacePluginCategory,
  MarketplaceRegistryPlugin,
  MarketplaceSearchPage,
  MarketplaceRestartResult,
  MarketplaceToggleResult,
} from '../types.ts'
import type { PluginMarketplaceLocaleKey } from './locales.ts'

/** Registration-side Remote face used by the section. */
export interface MarketplaceTabInjected {
  search: (
    query: string,
    page: number,
    sort: 'stars' | 'updated' | 'trending',
    category: MarketplacePluginCategory | 'all',
  ) => Promise<MarketplaceSearchPage>
  details: (repo: string, ref: string) => Promise<MarketplacePluginDetails>
  guidedAgent: (repo: string, ref: string, operation: 'install' | 'update') => Promise<void>
  install: (repo: string, ref: string) => Promise<string>
  manualInstall: (command: string) => Promise<MarketplaceManualInstallResult>
  update: (repo: string, ref: string) => Promise<string>
  uninstall: (packageName: string) => Promise<string>
  setEnabled: (packageName: string, enabled: boolean) => Promise<MarketplaceToggleResult>
  installLocation: () => Promise<MarketplaceInstallLocation>
  setInstallDir: (installDir: string) => Promise<MarketplaceInstallLocation>
  chooseInstallDir: () => Promise<string | null>
  diagnoseConflicts: () => Promise<MarketplaceDiagnoseConflictsResult>
  jobStatus: (jobId: string) => Promise<MarketplaceJobStatus>
  installed: () => Promise<MarketplaceInstalled>
  restart: () => Promise<MarketplaceRestartResult>
}

/** Full component props assembled by the Settings slot renderer. */
export type MarketplaceTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginMarketplace'>
  & InjectFace<MarketplaceTabInjected>

type ViewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; page: MarketplaceSearchPage }

type ConfirmRequest = {
  mode: 'install' | 'manual-install' | 'update' | 'uninstall' | 'restart'
  repo: string
  ref: string
  packageName: string
  command: string
}

type Subpage = 'catalog' | 'installed' | 'management'
type RestartState = 'idle' | 'requesting' | 'restarting'

type StartingAction = { packageName: string; kind: MarketplaceJobKind }

type Notice = { id: number; message: string; tone: 'error' | 'info' }

const POLL_MS = 700
const DEBOUNCE_MS = 400
const RESULT_PAGE_SIZE = 30
const SELF_PACKAGE = 'dsh-plugin-marketplace'
const CATEGORY_OPTIONS: MarketplacePluginCategory[] = [
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
]

const s = {
  section: { width: '100%', maxWidth: 920, display: 'flex', flexDirection: 'column', gap: 16, color: 'var(--dsw-alias-label-primary)' } as React.CSSProperties,
  subnav: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingBottom: 2 } as React.CSSProperties,
  subnavGroup: { display: 'flex', alignItems: 'center', gap: 8 } as React.CSSProperties,
  subnavMeta: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' } as React.CSSProperties,
  toolbar: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } as React.CSSProperties,
  search: { minWidth: 220, flex: '1 1 260px' } as React.CSSProperties,
  sortGroup: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, whiteSpace: 'nowrap', flexWrap: 'wrap' } as React.CSSProperties,
  categorySelect: {
    minWidth: 124,
    height: 30,
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 8,
    background: 'var(--dsw-alias-bg-layer-2)',
    color: 'var(--dsw-alias-label-secondary)',
    padding: '0 28px 0 10px',
    font: 'inherit',
    fontSize: 12,
  } as React.CSSProperties,
  rateRow: { display: 'flex', justifyContent: 'flex-end', minHeight: 20, marginTop: -8 } as React.CSSProperties,
  muted: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, lineHeight: '20px', margin: 0 } as React.CSSProperties,
  failure: { display: 'flex', alignItems: 'center', gap: 10, color: 'var(--dsw-alias-state-error-primary)', fontSize: 13 } as React.CSSProperties,
  banner: {
    border: '1px solid var(--dsw-alias-state-success-primary)',
    background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)',
    color: 'var(--dsw-alias-label-primary)',
    borderRadius: 8, padding: '8px 12px', fontSize: 13,
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
  } as React.CSSProperties,
  bannerText: { minWidth: 0, flex: 1 } as React.CSSProperties,
  cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 270px), 1fr))', gap: 12, margin: 0, padding: 0, listStyle: 'none', alignItems: 'start' } as React.CSSProperties,
  card: { border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-3)', borderRadius: 12, minWidth: 0, overflow: 'hidden' } as React.CSSProperties,
  cardBody: { minHeight: 232, boxSizing: 'border-box', padding: '16px 16px 12px', display: 'flex', flexDirection: 'column', gap: 8 } as React.CSSProperties,
  titleRow: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, minHeight: 22 } as React.CSSProperties,
  title: { fontSize: 14, fontWeight: 600, lineHeight: '22px', textOverflow: 'ellipsis', whiteSpace: 'nowrap', overflow: 'hidden', minWidth: 0 } as React.CSSProperties,
  authorLine: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, lineHeight: '17px', margin: '-4px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as React.CSSProperties,
  verifiedBadge: {
    display: 'inline-flex', alignItems: 'center', gap: 5, flex: 'none',
    color: 'var(--dsw-alias-state-success-primary)',
    background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)',
    border: '1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary) 28%, transparent)',
    borderRadius: 999, padding: '2px 7px', fontSize: 10, lineHeight: '16px',
  } as React.CSSProperties,
  verifiedDot: { width: 5, height: 5, borderRadius: '50%', background: 'var(--dsw-alias-state-success-primary)', flex: 'none' } as React.CSSProperties,
  description: { ...({ color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, lineHeight: '20px', margin: 0 } as React.CSSProperties), display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden', minHeight: 40 } as React.CSSProperties,
  statsRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, minHeight: 20, marginTop: 'auto' } as React.CSSProperties,
  statGroup: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 } as React.CSSProperties,
  stat: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px', whiteSpace: 'nowrap' } as React.CSSProperties,
  growth: { color: 'var(--dsw-alias-state-success-primary)', fontSize: 11, lineHeight: '18px', whiteSpace: 'nowrap' } as React.CSSProperties,
  updatedCompact: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, lineHeight: '18px', whiteSpace: 'nowrap' } as React.CSSProperties,
  chipRow: { display: 'flex', alignItems: 'center', gap: 6, minHeight: 22, overflow: 'hidden' } as React.CSSProperties,
  chip: {
    display: 'inline-flex', alignItems: 'center', flex: 'none', maxWidth: 112,
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 999,
    background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)',
    padding: '2px 8px', fontSize: 10, lineHeight: '16px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  } as React.CSSProperties,
  meta: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: '18px', whiteSpace: 'nowrap' } as React.CSSProperties,
  actions: { display: 'flex', alignItems: 'center', gap: 10, minHeight: 34, paddingTop: 10, borderTop: '1px solid var(--dsw-alias-border-l2)' } as React.CSSProperties,
  actionLinks: { minWidth: 0, marginLeft: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 14 } as React.CSSProperties,
  detailToggle: { display: 'flex', alignItems: 'center', gap: 6, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, background: 'none', border: 0, cursor: 'pointer', padding: 0, font: 'inherit' } as React.CSSProperties,
  details: { borderTop: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-module-platform)', padding: '10px 14px 12px', display: 'flex', flexDirection: 'column', gap: 8 } as React.CSSProperties,
  kv: { display: 'grid', gridTemplateColumns: '76px minmax(0, 1fr)', gap: '4px 10px', margin: 0 } as React.CSSProperties,
  kvDt: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, lineHeight: '17px' } as React.CSSProperties,
  kvDd: { overflowWrap: 'anywhere', minWidth: 0, color: 'var(--dsw-alias-label-secondary)', margin: 0, fontSize: 12, lineHeight: '17px' } as React.CSSProperties,
  patch: { overflowWrap: 'anywhere', fontFamily: 'var(--ds-font-family-code)', fontSize: 12, lineHeight: '18px', whiteSpace: 'pre-wrap', background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, padding: 8, maxHeight: 180, overflow: 'auto' } as React.CSSProperties,
  jobPanel: { border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', borderRadius: 10, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 } as React.CSSProperties,
  jobHead: { display: 'flex', alignItems: 'center', gap: 8 } as React.CSSProperties,
  jobLog: { overflowWrap: 'anywhere', fontFamily: 'var(--ds-font-family-code)', fontSize: 11, lineHeight: '16px', whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto', margin: 0, color: 'var(--dsw-alias-label-secondary)' } as React.CSSProperties,
  pager: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, padding: '4px 0' } as React.CSSProperties,
  link: { color: 'var(--dsw-alias-state-business-primary)', fontSize: 12, textDecoration: 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as React.CSSProperties,
  chevron: { flex: 'none' } as React.CSSProperties,
  tag: { color: 'var(--dsw-alias-state-success-primary)', fontSize: 11, lineHeight: '16px', flex: 'none' } as React.CSSProperties,
  installedList: { display: 'flex', flexDirection: 'column', gap: 10, margin: 0, padding: 0, listStyle: 'none' } as React.CSSProperties,
  installedToolbar: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } as React.CSSProperties,
  installedCard: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'center', gap: 16, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-3)', borderRadius: 10, padding: '14px 16px' } as React.CSSProperties,
  installedInfo: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 } as React.CSSProperties,
  installedDescription: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, lineHeight: '20px', margin: 0, overflowWrap: 'anywhere' } as React.CSSProperties,
  installedActions: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' } as React.CSSProperties,
  directoryPath: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', borderRadius: 8, padding: '9px 11px', fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 13 } as React.CSSProperties,
  toast: { position: 'fixed', top: 16, right: 16, zIndex: 99999, maxWidth: 460, minWidth: 260, display: 'flex', alignItems: 'flex-start', gap: 10, borderRadius: 10, padding: '12px 14px', fontSize: 13, lineHeight: '20px', boxShadow: '0 8px 24px rgba(0, 0, 0, 0.28)', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)' } as React.CSSProperties,
  toastError: { borderColor: 'var(--dsw-alias-state-error-primary)' } as React.CSSProperties,
  toastInfo: { borderColor: 'var(--dsw-alias-state-success-primary)' } as React.CSSProperties,
  toastText: { flex: 1, minWidth: 0, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' } as React.CSSProperties,
  toastClose: { background: 'none', border: 0, color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0 } as React.CSSProperties,
  panel: { border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-3)', borderRadius: 10, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 } as React.CSSProperties,
  field: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'center', gap: 10 } as React.CSSProperties,
  fieldLabel: { color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: '20px' } as React.CSSProperties,
  fieldMeta: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: '18px', margin: 0 } as React.CSSProperties,
  manualCommandRow: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'end', gap: 10 } as React.CSSProperties,
  conflictList: { display: 'flex', flexDirection: 'column', gap: 8, margin: 0, padding: 0, listStyle: 'none' } as React.CSSProperties,
  conflictItem: { border: '1px solid var(--dsw-alias-state-error-primary)', background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent)', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4 } as React.CSSProperties,
  conflictTitle: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 13, fontWeight: 600, lineHeight: '20px' } as React.CSSProperties,
  conflictBody: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px', margin: 0, overflowWrap: 'anywhere' } as React.CSSProperties,
  conflictHealthy: { color: 'var(--dsw-alias-state-success-primary)', fontSize: 13, fontWeight: 600, lineHeight: '20px' } as React.CSSProperties,
}

/** Interpolate the {placeholders} used by a few locale keys. */
function fmt(t: (key: PluginMarketplaceLocaleKey) => string, key: PluginMarketplaceLocaleKey, vars: Record<string, string | number>): string {
  let text = t(key)
  for (const [name, value] of Object.entries(vars)) {
    text = text.replace('{' + name + '}', String(value))
  }
  return text
}

function phaseDot(phase: string): StateDotState {
  if (phase === 'done') return 'done'
  if (phase === 'failed') return 'error'
  return 'ongoing'
}

function jobKindLabel(kind: string, t: MarketplaceTabProps['t']): string {
  if (kind === 'uninstall') return t('jobUninstall')
  if (kind === 'update') return t('jobUpdate')
  return t('jobInstall')
}

function jobPhaseLabel(phase: string, t: MarketplaceTabProps['t']): string {
  if (phase === 'done') return t('jobDone')
  if (phase === 'failed') return t('jobFailed')
  if (phase === 'reconciling') return t('jobReconciling')
  return t('jobRunning')
}

function categoryLabel(category: MarketplacePluginCategory, t: MarketplaceTabProps['t']): string {
  if (category === 'ui') return t('categoryUi')
  if (category === 'agents') return t('categoryAgents')
  if (category === 'developer-tools') return t('categoryDeveloperTools')
  if (category === 'models') return t('categoryModels')
  if (category === 'data') return t('categoryData')
  if (category === 'integrations') return t('categoryIntegrations')
  if (category === 'media') return t('categoryMedia')
  if (category === 'security') return t('categorySecurity')
  if (category === 'observability') return t('categoryObservability')
  return t('categoryOther')
}

/** Keep dates useful without letting a full locale date dominate a compact card. */
function compactDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const options: Intl.DateTimeFormatOptions = date.getFullYear() === new Date().getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' }
  return date.toLocaleDateString(undefined, options)
}

/** Failure notice: job headline plus the most relevant diagnostic log line. */
function jobFailureNotice(job: MarketplaceJobStatus, t: MarketplaceTabProps['t']): string {
  const heading = jobKindLabel(job.kind, t) + ' — ' + t('jobFailed') + ': ' + (job.failure?.message ?? t('error'))
  const lines = job.log.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
  const diagnostic = [...lines].reverse().find(line => /\b(ERR_|ERROR|Error:|failed|conflict|blocked)\b/i.test(line))
  return diagnostic === undefined || heading.includes(diagnostic) ? heading : heading + '\n' + diagnostic
}

function latestJobForPackage(jobs: Map<string, MarketplaceJobStatus>, packageName: string): MarketplaceJobStatus | undefined {
  return [...jobs.values()]
    .filter(job => job.packageName === packageName)
    .sort((left, right) => right.startedAt - left.startedAt)[0]
}

function activeJobLabel(job: { kind: string }, t: MarketplaceTabProps['t']): string {
  if (job.kind === 'uninstall') return t('uninstallingAction')
  if (job.kind === 'update') return t('updatingAction')
  return t('installingAction')
}

function friendlyPackageName(packageName: string): string {
  const slash = packageName.lastIndexOf('/')
  return slash >= 0 ? packageName.slice(slash + 1) : packageName
}

/** Render the marketplace: search, cards, install jobs, pagination. */
export function MarketplaceTab({ search, details, guidedAgent, install, manualInstall, update, uninstall, setEnabled, installLocation, setInstallDir, chooseInstallDir, diagnoseConflicts, jobStatus, installed, restart, t }: MarketplaceTabProps): ReactNode {

  const [view, setView] = useState<ViewState>({ status: 'loading' })
  const [subpage, setSubpage] = useState<Subpage>('catalog')
  const [query, setQuery] = useState('')
  const [installedQuery, setInstalledQuery] = useState('')
  const [manualCommand, setManualCommand] = useState('')
  const [manualBusy, setManualBusy] = useState(false)
  const [manualJobId, setManualJobId] = useState<string | null>(null)
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [sort, setSort] = useState<'stars' | 'updated' | 'trending'>('stars')
  const [category, setCategory] = useState<MarketplacePluginCategory | 'all'>('all')
  const [page, setPage] = useState(1)
  const [seq, setSeq] = useState(0)
  const [installedMap, setInstalledMap] = useState<Map<string, MarketplaceInstalledEntry>>(new Map())
  const [installedProfile, setInstalledProfile] = useState('')
  const [installedLoading, setInstalledLoading] = useState(true)
  const [installedError, setInstalledError] = useState<string | null>(null)
  const [jobs, setJobs] = useState<Map<string, MarketplaceJobStatus>>(new Map())
  const [startingAction, setStartingAction] = useState<StartingAction | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [detailsMap, setDetailsMap] = useState<Map<string, MarketplacePluginDetails>>(new Map())
  const [detailErrors, setDetailErrors] = useState<Map<string, string>>(new Map())
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [installDir, setInstallDirState] = useState('')
  const [installDirCustom, setInstallDirCustom] = useState(false)
  const [conflicts, setConflicts] = useState<MarketplaceConflict[]>([])
  const [installDirBusy, setInstallDirBusy] = useState(false)
  const [diagnosisBusy, setDiagnosisBusy] = useState(false)
  const [diagnosedAt, setDiagnosedAt] = useState<number | null>(null)
  const [toggleBusy, setToggleBusy] = useState<string | null>(null)
  const [restartState, setRestartState] = useState<RestartState>('idle')
  const [agentBusy, setAgentBusy] = useState<string | null>(null)
  const notifiedJobs = useRef<Set<string>>(new Set())

  const notify = useCallback((message: string, tone: 'error' | 'info' = 'error') => {
    setNotice({ id: Date.now(), message, tone })
  }, [])

  // Info notices auto-dismiss; errors stay until dismissed manually.
  useEffect(() => {
    if (notice === null) return undefined
    if (notice.tone === 'error') return undefined
    const handle = window.setTimeout(() => { setNotice(null) }, 8_000)
    return () => { window.clearTimeout(handle) }
  }, [notice])

  // Debounce the free-text query.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedQuery(query.trim())
      setPage(1)
    }, DEBOUNCE_MS)
    return () => { window.clearTimeout(handle) }
  }, [query])

  // Run the search.
  useEffect(() => {
    if (subpage !== 'catalog') return undefined
    let current = true
    setView({ status: 'loading' })
    void search(debouncedQuery, page, sort, category).then(
      (result) => { if (current) setView({ status: 'ready', page: result }) },
      (error: unknown) => {
        if (current) setView({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => { current = false }
  }, [debouncedQuery, sort, category, page, seq, search, subpage])

  const refreshInstalled = useCallback(() => {
    setInstalledLoading(true)
    void installed().then(
      (result) => {
        setInstalledMap(new Map(result.entries.map((entry) => [entry.packageName, entry])))
        setInstalledProfile(result.profile)
        if (typeof result.installDir === 'string' && result.installDir !== '') {
          setInstallDirState(result.installDir)
          setInstallDirCustom(Boolean(result.installDirCustom))
        }
        setConflicts(result.conflicts ?? [])
        setInstalledError(null)
        setInstalledLoading(false)
      },
      (error: unknown) => {
        setInstalledError(error instanceof Error ? error.message : String(error))
        setInstalledLoading(false)
      },
    )
  }, [installed])

  useEffect(() => { refreshInstalled() }, [refreshInstalled])

  // Keep the install directory in sync even before the first installed() call.
  useEffect(() => {
    let current = true
    void installLocation().then((result) => {
      if (!current) return
      setInstallDirState(result.installDir)
      setInstallDirCustom(Boolean(result.installDirCustom))
    }, (error: unknown) => {
      if (current) notify(error instanceof Error ? error.message : String(error))
    })
    return () => { current = false }
  }, [installLocation, notify])

  const loadDetails = useCallback((repo: string, verifiedCommit: string): Promise<MarketplacePluginDetails> => {
    const cached = detailsMap.get(repo)
    if (cached !== undefined) return Promise.resolve(cached)
    return details(repo, verifiedCommit).then((result) => {
      setDetailsMap((current) => new Map(current).set(repo, result))
      setDetailErrors((current) => {
        const next = new Map(current)
        next.delete(repo)
        return next
      })
      return result
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      setDetailErrors((current) => new Map(current).set(repo, message))
      throw error
    })
  }, [details, detailsMap])

  const trackJob = useCallback((jobId: string, kind: MarketplaceJobKind, packageName: string) => {
    setJobs((current) => {
      const next = new Map(current)
      next.set(jobId, {
        jobId,
        kind,
        packageName,
        phase: 'spawning',
        log: '',
        exitCode: null,
        startedAt: Date.now(),
        finishedAt: null,
        outcome: null,
        failure: null,
      })
      return next
    })
  }, [])

  // Poll every unfinished job until it settles.
  useEffect(() => {
    const pending = [...jobs.values()].filter((job) => job.finishedAt === null)
    if (pending.length === 0) return undefined
    const handle = window.setInterval(() => {
      for (const job of pending) {
        void jobStatus(job.jobId).then(
          (status) => {
            setJobs((current) => new Map(current).set(status.jobId, status))
            if (status.finishedAt !== null) {
              refreshInstalled()
              if (status.failure !== null && !notifiedJobs.current.has(status.jobId)) {
                notifiedJobs.current.add(status.jobId)
                notify(jobFailureNotice(status, t))
              }
              if (status.outcome !== null && status.outcome.requiresRestart) {
                setBanner(t('restartBanner'))
              }
            }
          },
          () => { /* keep polling; transient wire failures are common */ },
        )
      }
    }, POLL_MS)
    return () => { window.clearInterval(handle) }
  }, [jobs, jobStatus, notify, refreshInstalled, t])

  // Once the host accepts a restart, wait for it to go offline and come back.
  // The elapsed-time fallback covers a restart that is faster than one probe.
  useEffect(() => {
    if (restartState !== 'restarting') return undefined
    let disposed = false
    let sawOffline = false
    const startedAt = Date.now()
    const probe = async (): Promise<void> => {
      try {
        const url = new URL(window.location.href)
        url.searchParams.set('_dsh_restart_probe', String(Date.now()))
        await window.fetch(url, { cache: 'no-store', credentials: 'same-origin' })
        if (!disposed && (sawOffline || Date.now() - startedAt >= 8_000)) {
          const reloadUrl = new URL(window.location.href)
          reloadUrl.searchParams.set('_dsh_restarted', String(Date.now()))
          window.location.replace(reloadUrl.toString())
        }
      } catch {
        if (!disposed) sawOffline = true
      }
    }
    const first = window.setTimeout(() => { void probe() }, 750)
    const interval = window.setInterval(() => { void probe() }, 500)
    const fallback = window.setTimeout(() => {
      const reloadUrl = new URL(window.location.href)
      reloadUrl.searchParams.set('_dsh_restarted', String(Date.now()))
      window.location.replace(reloadUrl.toString())
    }, 30_000)
    return () => {
      disposed = true
      window.clearTimeout(first)
      window.clearInterval(interval)
      window.clearTimeout(fallback)
    }
  }, [restartState])

  const openConfirm = (mode: ConfirmRequest['mode'], repo: string, ref: string, packageName: string, command = ''): void => {
    setAcknowledged(false)
    setConfirm({ mode, repo, ref, packageName, command })
  }

  const runConfirm = (): void => {
    if (confirm === null) return
    setConfirm(null)
    setAcknowledged(false)
    const request = confirm
    if (request.mode === 'restart') {
      setRestartState('requesting')
      setBanner(t('restarting'))
      void restart().then(() => {
        setRestartState('restarting')
      }).catch((error: unknown) => {
        setRestartState('idle')
        notify(error instanceof Error ? error.message : String(error))
      })
      return
    }
    if (request.mode === 'manual-install') {
      setManualBusy(true)
      void manualInstall(request.command).then((result) => {
        setManualJobId(result.jobId)
        setManualCommand('')
        trackJob(result.jobId, 'install', result.packageName)
      }).catch((error: unknown) => {
        notify(error instanceof Error ? error.message : String(error))
      }).finally(() => { setManualBusy(false) })
      return
    }
    const jobKind = request.mode
    const start = jobKind === 'uninstall'
      ? uninstall(request.packageName)
      : jobKind === 'update'
        ? update(request.repo, request.ref)
        : install(request.repo, request.ref)
    setStartingAction({ packageName: request.packageName, kind: jobKind })
    void start.then((jobId) => {
      setStartingAction(null)
      trackJob(jobId, jobKind, request.packageName)
    }).catch((error: unknown) => {
      setStartingAction(null)
      notify(error instanceof Error ? error.message : String(error))
    })
  }

  const onInstall = (item: MarketplaceRegistryPlugin): void => {
    void loadDetails(
      item.fullName === '' ? item.owner + '/' + item.repo : item.fullName,
      item.verifiedCommit,
    ).then((result) => {
      if (result.manifest === null || result.manifest.bundlePatch === null) {
        notify(t('notAPlugin'), 'info')
        return
      }
      if (installedMap.has(result.manifest.name)) {
        notify(t('alreadyInstalled'), 'info')
        return
      }
      openConfirm('install', result.repo, result.resolvedRef, result.manifest.name)
    }).catch((error: unknown) => {
      notify(error instanceof Error ? error.message : String(error))
    })
  }

  const onGuidedAgent = (repo: string, ref: string, packageName: string, operation: 'install' | 'update'): void => {
    setAgentBusy(repo)
    setBanner(t('agentStarting'))
    void guidedAgent(repo, ref, operation).then(() => {
      setBanner(fmt(t, 'agentStarted', { package: packageName }))
    }).catch((error: unknown) => {
      notify(error instanceof Error ? error.message : String(error))
    }).finally(() => { setAgentBusy(null) })
  }

  const onSetEnabled = (entry: MarketplaceInstalledEntry): void => {
    const enabled = !entry.enabled
    setToggleBusy(entry.packageName)
    void setEnabled(entry.packageName, enabled).then((result) => {
      setInstalledMap((current) => {
        const next = new Map(current)
        const value = next.get(result.packageName)
        if (value !== undefined) next.set(result.packageName, { ...value, enabled: result.enabled })
        return next
      })
      if (result.requiresRestart) setBanner(t('restartBanner'))
      refreshInstalled()
    }).catch((error: unknown) => {
      notify(error instanceof Error ? error.message : String(error))
    }).finally(() => { setToggleBusy(null) })
  }

  const retry = (): void => { setSeq((value) => value + 1) }
  const openRestartConfirm = (): void => { openConfirm('restart', '', '', '') }

  const applyInstallDir = (value: string, noticeKey: PluginMarketplaceLocaleKey): void => {
    setInstallDirBusy(true)
    setInstallDir(value).then((result) => {
      setInstallDirState(result.installDir)
      setInstallDirCustom(Boolean(result.installDirCustom))
      notify(t(noticeKey), 'info')
      refreshInstalled()
    }).catch((error: unknown) => {
      notify(error instanceof Error ? error.message : String(error))
    }).finally(() => {
      setInstallDirBusy(false)
    })
  }

  const chooseInstallLocation = (): void => {
    setInstallDirBusy(true)
    void chooseInstallDir().then((value) => {
      if (value === null || value.trim() === '') {
        setInstallDirBusy(false)
        return
      }
      if (value === installDir) {
        notify(t('installDirUnchanged'), 'info')
        setInstallDirBusy(false)
        return
      }
      applyInstallDir(value, 'installDirSaved')
    }).catch((error: unknown) => {
      notify(error instanceof Error ? error.message : String(error))
      setInstallDirBusy(false)
    })
  }

  const resetInstallLocation = (): void => {
    applyInstallDir('', 'installDirReset')
  }

  const runDiagnosis = (): void => {
    setDiagnosisBusy(true)
    void diagnoseConflicts().then((result) => {
      setConflicts(result.conflicts)
      setDiagnosedAt(result.scannedAt)
      notify(
        result.conflicts.length === 0 ? t('diagnosisClean') : fmt(t, 'diagnosisFound', { count: result.conflicts.length }),
        result.conflicts.length === 0 ? 'info' : 'error',
      )
    }).catch((error: unknown) => {
      notify(error instanceof Error ? error.message : String(error))
    }).finally(() => {
      setDiagnosisBusy(false)
    })
  }

  const ready = view.status === 'ready' ? view.page : null
  const rate = ready?.rate ?? null
  const hasActiveJobs = [...jobs.values()].some((job) => job.finishedAt === null)
  const restartDisabled = restartState !== 'idle' || hasActiveJobs
  const isSelfUpdate = confirm?.mode === 'update' && confirm.packageName === SELF_PACKAGE
  const isManualInstall = confirm?.mode === 'manual-install'
  const manualJob = manualJobId === null ? undefined : jobs.get(manualJobId)
  const installedEntries = [...installedMap.values()].filter(entry => entry.isBundle)
  const installedNeedle = installedQuery.trim().toLocaleLowerCase()
  const visibleInstalledEntries = installedNeedle === ''
    ? installedEntries
    : installedEntries.filter((entry) => [
      entry.packageName,
      entry.description ?? '',
      entry.registryRepo ?? '',
      entry.version,
    ].some(value => value.toLocaleLowerCase().includes(installedNeedle)))

  return (
    <div style={s.section} aria-busy={view.status === 'loading' || restartState !== 'idle'}>
      {banner !== null ? (
        <div style={s.banner} role={banner === t('restartBanner') || restartState !== 'idle' ? 'status' : 'alert'}>
          <span style={s.bannerText}>{banner}</span>
          {banner === t('restartBanner') ? (
            <Button variant='outline' size='sm' disabled={restartDisabled} onClick={openRestartConfirm}>{t('restart')}</Button>
          ) : null}
        </div>
      ) : null}
      <div style={s.subnav}>
        <div style={s.subnavGroup}>
          <Pill active={subpage === 'catalog'} onClick={() => { setSubpage('catalog') }}>{t('catalog')}</Pill>
          <Pill active={subpage === 'installed'} onClick={() => { setSubpage('installed'); refreshInstalled() }}>{t('installedPage')}</Pill>
          <Pill active={subpage === 'management'} onClick={() => { setSubpage('management'); refreshInstalled() }}>{t('managementPage')}</Pill>
        </div>
        <div style={s.subnavMeta}>
          {installedProfile !== '' ? <span style={s.muted}>{fmt(t, 'currentProfile', { profile: installedProfile })}</span> : null}
          {subpage !== 'catalog' ? (
            <Button variant='outline' size='sm' disabled={restartDisabled} onClick={openRestartConfirm}>
              {restartState === 'idle' ? t('restart') : t('restarting')}
            </Button>
          ) : null}
        </div>
      </div>
      {subpage === 'catalog' ? (
        <>
          <div style={s.toolbar}>
            <div style={s.search}>
              <Input
                type='search'
                icon={<IconSearchOutline16 aria-hidden='true' />}
                value={query}
                placeholder={t('searchPlaceholder')}
                aria-label={t('searchPlaceholder')}
                onChange={(event) => { setQuery(event.currentTarget.value) }}
              />
            </div>
            <div style={s.sortGroup}>
              <select
                style={s.categorySelect}
                value={category}
                aria-label={t('category')}
                onChange={(event) => {
                  setCategory(event.currentTarget.value as MarketplacePluginCategory | 'all')
                  setPage(1)
                }}
              >
                <option value='all'>{t('categoryAll')}</option>
                {CATEGORY_OPTIONS.map((value) => <option key={value} value={value}>{categoryLabel(value, t)}</option>)}
              </select>
              <Pill active={sort === 'stars'} onClick={() => { setSort('stars'); setPage(1) }}>{t('sortStars')}</Pill>
              <Pill active={sort === 'trending'} onClick={() => { setSort('trending'); setPage(1) }}>{t('sortTrending')}</Pill>
              <Pill active={sort === 'updated'} onClick={() => { setSort('updated'); setPage(1) }}>{t('sortUpdated')}</Pill>
            </div>
          </div>
          {rate !== null && rate.limit > 0 ? (
            <div style={s.rateRow}>
              <span style={s.muted}>
                {fmt(t, 'rateLimit', { remaining: rate.remaining, reset: rate.reset > 0 ? Math.max(0, rate.reset - Math.floor(Date.now() / 1000)) + 's' : '—' })}
              </span>
            </div>
          ) : null}
          {view.status === 'loading' ? <p style={s.muted}>{t('loading')}</p> : null}
          {view.status === 'error' ? (
            <div style={s.failure}>
              <p role='alert' style={s.muted}>{t('error')} {view.message}</p>
              <Button variant='outline' size='sm' onClick={retry}>{t('retry')}</Button>
            </div>
          ) : null}
          {ready !== null && ready.items.length === 0 ? <p style={s.muted}>{debouncedQuery === '' && category === 'all' ? t('empty') : t('emptySearch')}</p> : null}
          {ready !== null && ready.items.length > 0 ? (
            <ul style={s.cards}>
              {ready.items.map((item) => (
                <CardRow
                  key={item.fullName}
                  item={item}
                  t={t}
                  currentProfile={installedProfile}
                  profileLoading={installedLoading}
                  profileAvailable={installedError === null && installedProfile !== ''}
                  isInstalled={installedMap.has(item.packageName)}
                  job={latestJobForPackage(jobs, item.packageName)}
                  startingKind={startingAction?.packageName === item.packageName ? startingAction.kind : null}
                  expanded={expanded === item.fullName}
                  detail={detailsMap.get(item.fullName)}
                  detailError={detailErrors.get(item.fullName)}
                  onToggle={() => {
                    if (expanded === item.fullName) { setExpanded(null); return }
                    setExpanded(item.fullName)
                    void loadDetails(item.fullName, item.verifiedCommit).catch(() => { /* the error renders in the card */ })
                  }}
                  onInstall={() => { onInstall(item) }}
                  onGuidedAgent={() => { onGuidedAgent(item.fullName, item.verifiedCommit, item.packageName, 'install') }}
                  agentBusy={agentBusy === item.fullName}
                />
              ))}
            </ul>
          ) : null}
          {ready !== null ? (
            <div style={s.pager}>
              <Button variant='outline' size='sm' disabled={page <= 1} onClick={() => { setPage((value) => Math.max(1, value - 1)) }}>{t('pagePrev')}</Button>
              <span style={s.muted}>{fmt(t, 'pageOf', { page })} · {fmt(t, 'total', { total: ready.totalCount })}</span>
              <Button variant='outline' size='sm' disabled={page * RESULT_PAGE_SIZE >= ready.totalCount} onClick={() => { setPage((value) => value + 1) }}>{t('pageNext')}</Button>
            </div>
          ) : null}
        </>
      ) : subpage === 'installed' ? (
        <>
          <div style={s.installedToolbar}>
            <div style={s.search}>
              <Input
                type='search'
                icon={<IconSearchOutline16 aria-hidden='true' />}
                value={installedQuery}
                placeholder={t('installedSearchPlaceholder')}
                aria-label={t('installedSearchPlaceholder')}
                onChange={(event) => { setInstalledQuery(event.currentTarget.value) }}
              />
            </div>
          </div>
          <InstalledList
            entries={visibleInstalledEntries}
            currentProfile={installedProfile}
            loading={installedLoading}
            error={installedError}
            emptyMessage={installedNeedle === '' ? t('emptyInstalled') : t('emptyInstalledSearch')}
            t={t}
            onRetry={refreshInstalled}
            onUpdate={(entry) => {
              if (entry.registryRepo !== null && entry.verifiedCommit !== null) {
                openConfirm('update', entry.registryRepo, entry.verifiedCommit, entry.packageName)
              }
            }}
            onUninstall={(entry) => { openConfirm('uninstall', '', '', entry.packageName) }}
            onSetEnabled={onSetEnabled}
            onAgentUpdate={(entry) => {
              if (entry.registryRepo === null || entry.verifiedCommit === null || entry.install === null) return
              onGuidedAgent(entry.registryRepo, entry.verifiedCommit, entry.packageName, 'update')
            }}
            agentBusy={agentBusy}
            toggleBusy={toggleBusy}
            jobs={jobs}
            startingAction={startingAction}
          />
        </>
      ) : (
        <>
          <p style={s.muted}>{t('managementHint')}</p>
          <ManualInstallPanel
            command={manualCommand}
            profile={installedProfile}
            busy={manualBusy || (manualJob !== undefined && manualJob.finishedAt === null)}
            job={manualJob}
            onCommandChange={setManualCommand}
            onInstall={() => { openConfirm('manual-install', '', '', '', manualCommand.trim()) }}
            t={t}
          />
          <InstallDirField
            installDir={installDir}
            installDirCustom={installDirCustom}
            onChoose={chooseInstallLocation}
            onReset={resetInstallLocation}
            busy={installDirBusy}
            t={t}
          />
          <ConflictPanel
            conflicts={conflicts}
            diagnosedAt={diagnosedAt}
            busy={diagnosisBusy}
            onDiagnose={runDiagnosis}
            t={t}
          />
        </>
      )}
      <RiskConfirmation
        open={confirm !== null}
        title={confirm?.mode === 'restart' ? t('confirmRestartTitle') : confirm?.mode === 'uninstall' ? t('confirmUninstallTitle') : isManualInstall ? t('confirmManualInstallTitle') : isSelfUpdate ? t('confirmSelfUpdateTitle') : confirm?.mode === 'update' ? t('confirmUpdateTitle') : t('confirmTitle')}
        description={confirm?.mode === 'restart' ? t('confirmRestartDescription') : confirm?.mode === 'uninstall' ? t('confirmUninstallDescription') : isManualInstall ? t('confirmManualInstallDescription') : isSelfUpdate ? t('confirmSelfUpdateDescription') : confirm?.mode === 'update' ? t('confirmUpdateDescription') : t('confirmDescription')}
        acknowledgeLabel={confirm?.mode === 'restart' ? t('acknowledgeRestart') : confirm?.mode === 'uninstall' ? t('acknowledgeUninstall') : isManualInstall ? t('acknowledgeManualInstall') : t('acknowledge')}
        cancelLabel={t('cancel')}
        confirmLabel={confirm?.mode === 'restart' ? t('confirmRestart') : confirm?.mode === 'uninstall' ? t('confirmUninstall') : isManualInstall ? t('confirmManualInstall') : isSelfUpdate ? t('selfUpdate') : confirm?.mode === 'update' ? t('confirmUpdate') : t('confirm')}
        acknowledged={acknowledged}
        onAcknowledgedChange={setAcknowledged}
        onCancel={() => { setConfirm(null); setAcknowledged(false) }}
        onConfirm={runConfirm}
      />
      {notice !== null ? (
        <div
          style={notice.tone === 'error' ? { ...s.toast, ...s.toastError } : { ...s.toast, ...s.toastInfo }}
          role='alert'
        >
          <span style={s.toastText}>{notice.message}</span>
          <button type='button' style={s.toastClose} aria-label={t('dismiss')} onClick={() => { setNotice(null) }}>×</button>
        </div>
      ) : null}
    </div>
  )
}

interface CardRowProps {
  item: MarketplaceRegistryPlugin
  t: MarketplaceTabProps['t']
  currentProfile: string
  profileLoading: boolean
  profileAvailable: boolean
  isInstalled: boolean
  job: MarketplaceJobStatus | undefined
  startingKind: MarketplaceJobKind | null
  expanded: boolean
  detail: MarketplacePluginDetails | undefined
  detailError: string | undefined
  onToggle: () => void
  onInstall: () => void
  onGuidedAgent: () => void
  agentBusy: boolean
}

function CardRow({ item, t, currentProfile, profileLoading, profileAvailable, isInstalled, job, startingKind, expanded, detail, detailError, onToggle, onInstall, onGuidedAgent, agentBusy }: CardRowProps): ReactNode {
  const canInstall = item.install.mode === 'automatic'
    && (item.install.source === 'github' || item.install.source === 'npm')
    && currentProfile !== ''
    && item.install.profiles.includes(currentProfile)
  const canUseAgent = item.install.mode === 'guided'
    && currentProfile !== ''
    && (item.install.profiles.length === 0 || item.install.profiles.includes(currentProfile))
  const jobActive = job !== undefined && job.finishedAt === null
  const operationActive = startingKind !== null || jobActive
  return (
    <li style={s.card}>
      <div style={s.cardBody}>
        <div style={s.titleRow}>
          <strong style={s.title} title={item.fullName}>
            {item.repo}
          </strong>
          <span style={s.verifiedBadge}><span style={s.verifiedDot} aria-hidden='true' />{t('verified')}</span>
        </div>
        <p style={s.authorLine} title={item.owner}>{fmt(t, 'repositoryAuthor', { author: item.owner })}</p>
        <p style={s.description} title={item.description ?? undefined}>{item.description === null || item.description === '' ? '\u00A0' : item.description}</p>
        <div style={s.statsRow}>
          <div style={s.statGroup}>
            <span style={s.stat} title={t('stars')}>★ {item.stars}</span>
            {item.starGrowth7d > 0 ? <span style={s.growth}>{fmt(t, 'starGrowth7d', { stars: item.starGrowth7d })}</span> : null}
          </div>
          {item.updatedAt !== '' ? <span style={s.updatedCompact} title={t('updated') + ' ' + new Date(item.updatedAt).toLocaleDateString()}>{compactDate(item.updatedAt)}</span> : null}
        </div>
        <div style={s.chipRow}>
          {item.categories.slice(0, 2).map((category) => <span key={category} style={s.chip}>{categoryLabel(category, t)}</span>)}
        </div>
        <div style={s.actions}>
          {operationActive ? (
            <Button variant='primary' size='sm' disabled>{activeJobLabel({ kind: job?.kind ?? startingKind ?? 'install' }, t)}</Button>
          ) : isInstalled ? (
            <Button variant='outline' size='sm' disabled>{t('installedTag')}</Button>
          ) : profileLoading ? (
            <Button variant='outline' size='sm' disabled>{t('checkingInstall')}</Button>
          ) : !profileAvailable ? (
            <Button variant='outline' size='sm' disabled>{t('installUnavailable')}</Button>
          ) : canInstall ? (
            <Button variant='primary' size='sm' onClick={onInstall}>{t('install')}</Button>
          ) : canUseAgent ? (
            <Button variant='primary' size='sm' disabled={agentBusy} onClick={onGuidedAgent}>
              {agentBusy ? t('agentBusy') : t('agentInstall')}
            </Button>
          ) : (
            <a style={s.link} href={item.install.instructionsUrl} target='_blank' rel='noreferrer'>{t('installGuide')}</a>
          )}
          <div style={s.actionLinks}>
            <a style={s.link} href={item.htmlUrl} target='_blank' rel='noreferrer' title={item.fullName}>{t('openInGithub')}</a>
            <button type='button' style={s.detailToggle} aria-expanded={expanded} onClick={onToggle}>
              {t('details')}
              <span style={{ ...s.chevron, display: 'inline-flex', transform: expanded ? 'rotate(180deg)' : undefined }}>
                <IconChevronDownOutline14 size={12} aria-hidden='true' />
              </span>
            </button>
          </div>
        </div>
      </div>
      {expanded ? (
        <div style={s.details}>
          {detailError !== undefined ? <p style={s.failure} role='alert'>{detailError}</p> : null}
          {detail === undefined && detailError === undefined ? <p style={s.muted}>{t('loading')}</p> : null}
          {detail !== undefined && detail.manifest === null ? <p style={s.muted}>{t('noManifest')}</p> : null}
          {detail !== undefined && detail.manifest !== null ? (
            <dl style={s.kv}>
              <dt style={s.kvDt}>{t('manifest')}</dt>
              <dd style={s.kvDd}>{detail.manifest.name + '@' + detail.manifest.version}</dd>
              <dt style={s.kvDt}>{t('license')}</dt>
              <dd style={s.kvDd}>{detail.manifest.license ?? t('none')}</dd>
              <dt style={s.kvDt}>{t('language')}</dt>
              <dd style={s.kvDd}>{item.language ?? t('none')}</dd>
              <dt style={s.kvDt}>{t('category')}</dt>
              <dd style={s.kvDd}>{item.categories.map((category) => categoryLabel(category, t)).join(', ')}</dd>
              {detail.manifest.hasClient ? (
                <>
                  <dt style={s.kvDt}>{t('hasClient')}</dt>
                  <dd style={s.kvDd}>web</dd>
                </>
              ) : null}
              <dt style={s.kvDt}>{t('verifiedCommit')}</dt>
              <dd style={s.kvDd}>{detail.resolvedRef}</dd>
              <dt style={s.kvDt}>{t('installSource')}</dt>
              <dd style={s.kvDd}>{item.install.source} · {item.install.mode === 'automatic' ? t('automaticInstall') : t('guidedInstall')}</dd>
              <dt style={s.kvDt}>{t('profiles')}</dt>
              <dd style={s.kvDd}>{item.install.profiles.length > 0 ? item.install.profiles.join(', ') : t('profileUnknown')}</dd>
            </dl>
          ) : null}
          {detail?.patch !== null && detail?.patch !== undefined ? (
            <pre style={s.patch}>{detail.patch}</pre>
          ) : null}
        </div>
      ) : null}
      {job !== undefined ? <JobPanel job={job} t={t} /> : null}
    </li>
  )
}

interface InstalledListProps {
  entries: MarketplaceInstalledEntry[]
  currentProfile: string
  loading: boolean
  error: string | null
  emptyMessage: string
  t: MarketplaceTabProps['t']
  onRetry: () => void
  onUpdate: (entry: MarketplaceInstalledEntry) => void
  onUninstall: (entry: MarketplaceInstalledEntry) => void
  onSetEnabled: (entry: MarketplaceInstalledEntry) => void
  onAgentUpdate: (entry: MarketplaceInstalledEntry) => void
  agentBusy: string | null
  toggleBusy: string | null
  jobs: Map<string, MarketplaceJobStatus>
  startingAction: StartingAction | null
}

function InstalledList({ entries, currentProfile, loading, error, emptyMessage, t, onRetry, onUpdate, onUninstall, onSetEnabled, onAgentUpdate, agentBusy, toggleBusy, jobs, startingAction }: InstalledListProps): ReactNode {
  if (loading) return <p style={s.muted}>{t('loadingInstalled')}</p>
  if (error !== null) {
    return (
      <div style={s.failure}>
        <p role='alert' style={s.muted}>{t('installedError')} {error}</p>
        <Button variant='outline' size='sm' onClick={onRetry}>{t('retry')}</Button>
      </div>
    )
  }
  if (entries.length === 0) return <p style={s.muted}>{emptyMessage}</p>
  return (
    <ul style={s.installedList}>
      {entries.map((entry) => {
        const job = latestJobForPackage(jobs, entry.packageName)
        const jobActive = job !== undefined && job.finishedAt === null
        const startingKind = startingAction?.packageName === entry.packageName ? startingAction.kind : null
        const operationActive = startingKind !== null || jobActive
        return (
          <li key={entry.packageName} style={s.installedCard}>
            <div style={s.installedInfo}>
              <strong style={s.title} title={entry.packageName}>{friendlyPackageName(entry.packageName)}</strong>
              <span style={s.meta}>{entry.packageName}</span>
              {entry.description ? <p style={s.installedDescription}>{entry.description}</p> : null}
              <span style={s.muted} title={entry.currentSpec}>
                {fmt(t, 'installedVersion', { version: entry.version })}
                {entry.availableVersion !== null
                  ? ' · ' + fmt(t, entry.availableVersionSource === 'repository' ? 'repositoryVersion' : 'registryVersion', { version: entry.availableVersion })
                  : ''}
              </span>
              {!entry.linked ? (
                <span style={s.meta} title={entry.location}>{t('directoryOnly')}</span>
              ) : (
                <span style={entry.updateAvailable ? s.tag : s.meta}>
                  {entry.registryRepo === null
                    ? t('notInRegistry')
                    : entry.updateAvailable
                      ? t('updateAvailable')
                      : t('upToDate')}
                </span>
              )}
              {entry.linked ? <span style={entry.enabled ? s.tag : s.meta}>{entry.enabled ? t('enabled') : t('disabled')}</span> : null}
            </div>
            <div style={s.installedActions}>
              {!entry.linked ? (
                <Button variant='outline' size='sm' disabled>{t('profileActionsUnavailable')}</Button>
              ) : operationActive ? (
                <Button variant='primary' size='sm' disabled>{activeJobLabel({ kind: job?.kind ?? startingKind ?? 'install' }, t)}</Button>
              ) : entry.updateAvailable && entry.canUpdate ? (
                <Button variant='primary' size='sm' onClick={() => { onUpdate(entry) }}>
                  {entry.packageName === SELF_PACKAGE ? t('selfUpdate') : t('update')}
                </Button>
              ) : entry.updateAvailable
                && entry.install?.mode === 'guided'
                && entry.registryRepo !== null
                && entry.verifiedCommit !== null
                && (entry.install.profiles.length === 0 || entry.install.profiles.includes(currentProfile)) ? (
                  <Button variant='primary' size='sm' disabled={agentBusy === entry.registryRepo} onClick={() => { onAgentUpdate(entry) }}>
                    {agentBusy === entry.registryRepo ? t('agentStarting') : t('agentUpdate')}
                  </Button>
              ) : entry.updateAvailable && entry.install !== null ? (
                <a style={s.link} href={entry.install.instructionsUrl} target='_blank' rel='noreferrer'>{t('installGuide')}</a>
              ) : (
                <Button variant='outline' size='sm' disabled>{t('upToDate')}</Button>
              )}
              <Button variant='outline' size='sm' disabled={!entry.linked || operationActive || toggleBusy === entry.packageName} onClick={() => { onSetEnabled(entry) }}>
                {entry.enabled ? t('disable') : t('enable')}
              </Button>
              <Button variant='outline' size='sm' disabled={!entry.linked || operationActive} onClick={() => { onUninstall(entry) }}>{t('uninstall')}</Button>
            </div>
            {job !== undefined ? (
              <div style={{ gridColumn: '1 / -1', width: '100%' }}>
                <JobPanel job={job} t={t} />
              </div>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

function ManualInstallPanel({ command, profile, busy, job, onCommandChange, onInstall, t }: {
  command: string
  profile: string
  busy: boolean
  job: MarketplaceJobStatus | undefined
  onCommandChange: (value: string) => void
  onInstall: () => void
  t: MarketplaceTabProps['t']
}): ReactNode {
  const currentProfile = profile === '' ? 'web' : profile
  return (
    <div style={s.panel}>
      <strong style={s.fieldLabel}>{t('manualInstallTitle')}</strong>
      <p style={s.fieldMeta}>{t('manualInstallDescription')}</p>
      <div style={s.manualCommandRow}>
        <Input
          type='text'
          value={command}
          placeholder={fmt(t, 'manualInstallPlaceholder', { profile: currentProfile })}
          aria-label={t('manualInstallCommandLabel')}
          disabled={busy}
          onChange={(event) => { onCommandChange(event.currentTarget.value) }}
        />
        <Button variant='primary' size='sm' disabled={busy || profile === '' || command.trim() === ''} onClick={onInstall}>
          {busy ? t('manualInstallStarting') : t('manualInstallAction')}
        </Button>
      </div>
      <p style={s.fieldMeta}>{t('manualInstallHint')}</p>
      {job !== undefined ? <JobPanel job={job} t={t} /> : null}
    </div>
  )
}

function InstallDirField({ installDir, installDirCustom, onChoose, onReset, busy, t }: {
  installDir: string
  installDirCustom: boolean
  onChoose: () => void
  onReset: () => void
  busy: boolean
  t: MarketplaceTabProps['t']
}): ReactNode {
  const displayDir = installDir || t('installDirUnavailable')
  return (
    <div style={s.panel}>
      <strong style={s.fieldLabel}>{t('installDirTitle')}</strong>
      {installDirCustom
        ? <p style={s.fieldMeta}>{fmt(t, 'installDirCustomHint', { dir: displayDir })}</p>
        : <p style={s.fieldMeta}>{fmt(t, 'installDirDefaultHint', { dir: displayDir })}</p>}
      <input style={s.directoryPath} value={displayDir} readOnly title={displayDir} aria-label={t('installDirPathLabel')} />
      <div style={s.installedActions}>
        <Button variant='primary' size='sm' disabled={busy} onClick={onChoose}>
          {busy ? t('installDirChoosing') : t('installDirChoose')}
        </Button>
        {installDirCustom ? (
          <Button variant='outline' size='sm' disabled={busy} onClick={onReset}>{t('installDirResetAction')}</Button>
        ) : null}
      </div>
      <p style={s.fieldMeta}>{t('installDirResetHint')}</p>
    </div>
  )
}

function ConflictPanel({ conflicts, diagnosedAt, busy, onDiagnose, t }: {
  conflicts: MarketplaceConflict[]
  diagnosedAt: number | null
  busy: boolean
  onDiagnose: () => void
  t: MarketplaceTabProps['t']
}): ReactNode {
  const header = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', width: '100%' }}>
      <strong style={conflicts.length === 0 ? s.conflictHealthy : s.conflictTitle}>
        {conflicts.length === 0 ? t('conflictNone') : fmt(t, 'conflictTitle', { count: conflicts.length })}
      </strong>
      <Button variant='outline' size='sm' disabled={busy} onClick={onDiagnose}>
        {busy ? t('diagnosing') : t('diagnoseNow')}
      </Button>
    </div>
  )
  if (conflicts.length === 0) {
    return (
      <div style={s.panel}>
        {header}
        <p style={s.conflictBody}>{t('conflictHint')}</p>
        {diagnosedAt !== null ? <p style={s.fieldMeta}>{fmt(t, 'diagnosedAt', { time: new Date(diagnosedAt).toLocaleString() })}</p> : null}
      </div>
    )
  }
  return (
    <div style={s.panel}>
      {header}
      <ul style={s.conflictList}>
        {conflicts.map((conflict) => (
          <li
            key={conflict.kind === 'service' ? 'svc:' + conflict.service : 'id:' + conflict.id}
            style={s.conflictItem}
          >
            <span style={s.conflictTitle}>
              {conflict.kind === 'service'
                ? fmt(t, 'conflictService', { service: conflict.service })
                : fmt(t, 'conflictDuplicateId', { id: conflict.id })}
            </span>
            <p style={s.conflictBody}>{conflict.packages.join(', ')}</p>
          </li>
        ))}
      </ul>
      <p style={s.conflictBody}>{t('conflictHint')}</p>
      {diagnosedAt !== null ? <p style={s.fieldMeta}>{fmt(t, 'diagnosedAt', { time: new Date(diagnosedAt).toLocaleString() })}</p> : null}
    </div>
  )
}

function JobPanel({ job, t }: { job: MarketplaceJobStatus; t: MarketplaceTabProps['t'] }): ReactNode {
  const settled = job.finishedAt !== null
  const label = settled && job.failure !== null
    ? jobKindLabel(job.kind, t) + ' — ' + t('jobFailed') + ': ' + job.failure.message
    : settled && job.outcome !== null
      ? jobKindLabel(job.kind, t) + ' — ' + t('jobDone') + ' (' + job.outcome.packageName + '@' + job.outcome.version + ')'
      : jobKindLabel(job.kind, t) + ' — ' + jobPhaseLabel(job.phase, t)
  return (
    <div style={s.jobPanel}>
      <div style={s.jobHead}>
        <StateDot state={phaseDot(job.phase)} aria-hidden='true' />
        <span style={s.muted}>{label}</span>
      </div>
      {job.log !== '' ? (
        <details open={settled && job.failure !== null}>
          <summary style={s.detailToggle}>{t('jobLog')}</summary>
          <pre style={s.jobLog}>{job.log}</pre>
        </details>
      ) : null}
    </div>
  )
}
