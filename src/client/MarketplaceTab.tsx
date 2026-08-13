import { useCallback, useEffect, useState, type ReactNode } from 'react'
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
  MarketplaceInstalledEntry,
  MarketplaceJobStatus,
  MarketplacePluginDetails,
  MarketplaceRepoSummary,
  MarketplaceSearchPage,
} from '../types.ts'
import type { PluginMarketplaceLocaleKey } from './locales.ts'

/** Registration-side Remote face used by the section. */
export interface MarketplaceTabInjected {
  search: (query: string, page: number, sort: 'stars' | 'updated') => Promise<MarketplaceSearchPage>
  details: (repo: string, ref: string) => Promise<MarketplacePluginDetails>
  install: (repo: string, ref: string) => Promise<string>
  update: (repo: string, ref: string) => Promise<string>
  uninstall: (packageName: string) => Promise<string>
  jobStatus: (jobId: string) => Promise<MarketplaceJobStatus>
  installed: () => Promise<MarketplaceInstalledEntry[]>
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
  mode: 'install' | 'update' | 'uninstall'
  repo: string
  ref: string
  packageName: string
}

const POLL_MS = 700
const DEBOUNCE_MS = 400
const RESULT_PAGE_SIZE = 30

const s = {
  section: { width: '100%', maxWidth: 920, display: 'flex', flexDirection: 'column', gap: 16, color: 'var(--dsw-alias-label-primary)' } as React.CSSProperties,
  toolbar: { display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) auto', alignItems: 'center', gap: 12 } as React.CSSProperties,
  search: { minWidth: 0 } as React.CSSProperties,
  sortGroup: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, whiteSpace: 'nowrap' } as React.CSSProperties,
  rateRow: { display: 'flex', justifyContent: 'flex-end', minHeight: 20, marginTop: -8 } as React.CSSProperties,
  muted: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, lineHeight: '20px', margin: 0 } as React.CSSProperties,
  failure: { display: 'flex', alignItems: 'center', gap: 10, color: 'var(--dsw-alias-state-error-primary)', fontSize: 13 } as React.CSSProperties,
  banner: {
    border: '1px solid var(--dsw-alias-state-success-primary)',
    background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)',
    color: 'var(--dsw-alias-label-primary)',
    borderRadius: 8, padding: '8px 12px', fontSize: 13,
  } as React.CSSProperties,
  cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 250px), 1fr))', gap: 12, margin: 0, padding: 0, listStyle: 'none', alignItems: 'start' } as React.CSSProperties,
  card: { border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-3)', borderRadius: 10, minWidth: 0, overflow: 'hidden' } as React.CSSProperties,
  cardBody: { minHeight: 190, boxSizing: 'border-box', padding: '14px 16px 12px', display: 'flex', flexDirection: 'column', gap: 8 } as React.CSSProperties,
  titleRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 } as React.CSSProperties,
  title: { fontSize: 14, fontWeight: 600, lineHeight: '20px', textOverflow: 'ellipsis', whiteSpace: 'nowrap', overflow: 'hidden', minWidth: 0 } as React.CSSProperties,
  description: { ...({ color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, lineHeight: '20px', margin: 0 } as React.CSSProperties), display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 3, overflow: 'hidden', minHeight: 60 } as React.CSSProperties,
  metaRow: { display: 'flex', alignContent: 'flex-start', alignItems: 'center', gap: '2px 8px', flexWrap: 'wrap', minHeight: 38, marginTop: 'auto' } as React.CSSProperties,
  meta: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: '18px', whiteSpace: 'nowrap' } as React.CSSProperties,
  actions: { display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr) auto', alignItems: 'center', gap: 10, minHeight: 32, paddingTop: 10, marginTop: 2, borderTop: '1px solid var(--dsw-alias-border-l2)' } as React.CSSProperties,
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

/** Render the marketplace: search, cards, install jobs, pagination. */
export function MarketplaceTab({ search, details, install, update, uninstall, jobStatus, installed, t }: MarketplaceTabProps): ReactNode {

  const [view, setView] = useState<ViewState>({ status: 'loading' })
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [sort, setSort] = useState<'stars' | 'updated'>('stars')
  const [page, setPage] = useState(1)
  const [seq, setSeq] = useState(0)
  const [installedMap, setInstalledMap] = useState<Map<string, MarketplaceInstalledEntry>>(new Map())
  const [jobs, setJobs] = useState<Map<string, MarketplaceJobStatus>>(new Map())
  const [expanded, setExpanded] = useState<string | null>(null)
  const [detailsMap, setDetailsMap] = useState<Map<string, MarketplacePluginDetails>>(new Map())
  const [detailErrors, setDetailErrors] = useState<Map<string, string>>(new Map())
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)

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
    let current = true
    setView({ status: 'loading' })
    void search(debouncedQuery, page, sort).then(
      (result) => { if (current) setView({ status: 'ready', page: result }) },
      (error: unknown) => {
        if (current) setView({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => { current = false }
  }, [debouncedQuery, sort, page, seq, search])

  const refreshInstalled = useCallback(() => {
    void installed().then(
      (entries) => {
        setInstalledMap(new Map(entries.map((entry) => [entry.packageName, entry])))
      },
      () => { /* the installed listing is auxiliary; search errors already surface */ },
    )
  }, [installed])

  useEffect(() => { refreshInstalled() }, [refreshInstalled])

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

  const trackJob = useCallback((jobId: string) => {
    setJobs((current) => {
      const next = new Map(current)
      next.set(jobId, {
        jobId,
        kind: 'install',
        packageName: '',
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
  }, [jobs, jobStatus, refreshInstalled, t])

  const openConfirm = (mode: ConfirmRequest['mode'], repo: string, ref: string, packageName: string): void => {
    setAcknowledged(false)
    setConfirm({ mode, repo, ref, packageName })
  }

  const runConfirm = (): void => {
    if (confirm === null) return
    setConfirm(null)
    setAcknowledged(false)
    const request = confirm
    const start = request.mode === 'uninstall'
      ? uninstall(request.packageName)
      : request.mode === 'update'
        ? update(request.repo, request.ref)
        : install(request.repo, request.ref)
    void start.then(trackJob).catch((error: unknown) => {
      setBanner(error instanceof Error ? error.message : String(error))
    })
  }

  const onInstall = (item: MarketplaceRepoSummary): void => {
    void loadDetails(
      item.fullName === '' ? item.owner + '/' + item.repo : item.fullName,
      item.verifiedCommit,
    ).then((result) => {
      if (result.manifest === null || result.manifest.bundlePatch === null) {
        setBanner(t('notAPlugin'))
        return
      }
      if (installedMap.has(result.manifest.name)) {
        setBanner(t('alreadyInstalled'))
        return
      }
      openConfirm('install', result.repo, result.resolvedRef, result.manifest.name)
    }).catch((error: unknown) => {
      setBanner(error instanceof Error ? error.message : String(error))
    })
  }

  const retry = (): void => { setSeq((value) => value + 1) }

  const ready = view.status === 'ready' ? view.page : null
  const rate = ready?.rate ?? null

  return (
    <div style={s.section} aria-busy={view.status === 'loading'}>
      {banner !== null ? <div style={s.banner} role={banner.startsWith(t('restartBanner')) ? 'status' : 'alert'}>{banner}</div> : null}
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
          <Pill active={sort === 'stars'} onClick={() => { setSort('stars') }}>{t('sortStars')}</Pill>
          <Pill active={sort === 'updated'} onClick={() => { setSort('updated') }}>{t('sortUpdated')}</Pill>
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
      {ready !== null && ready.items.length === 0 ? <p style={s.muted}>{debouncedQuery === '' ? t('empty') : t('emptySearch')}</p> : null}
      {ready !== null && ready.items.length > 0 ? (
        <ul style={s.cards}>
          {ready.items.map((item) => (
            <CardRow
              key={item.fullName}
              item={item}
              t={t}
              expanded={expanded === item.fullName}
              detail={detailsMap.get(item.fullName)}
              detailError={detailErrors.get(item.fullName)}
              onToggle={() => {
                if (expanded === item.fullName) { setExpanded(null); return }
                setExpanded(item.fullName)
                void loadDetails(item.fullName, item.verifiedCommit).catch(() => { /* the error renders in the card */ })
              }}
              onInstall={() => { onInstall(item) }}
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
      {jobs.size > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[...jobs.values()].map((job) => (
            <JobPanel key={job.jobId} job={job} t={t} />
          ))}
        </div>
      ) : null}
      <RiskConfirmation
        open={confirm !== null}
        title={confirm?.mode === 'uninstall' ? t('confirmUninstallTitle') : t('confirmTitle')}
        description={confirm?.mode === 'uninstall' ? t('confirmUninstallDescription') : t('confirmDescription')}
        acknowledgeLabel={confirm?.mode === 'uninstall' ? t('acknowledgeUninstall') : t('acknowledge')}
        cancelLabel={t('cancel')}
        confirmLabel={confirm?.mode === 'uninstall' ? t('confirmUninstall') : t('confirm')}
        acknowledged={acknowledged}
        onAcknowledgedChange={setAcknowledged}
        onCancel={() => { setConfirm(null); setAcknowledged(false) }}
        onConfirm={runConfirm}
      />
    </div>
  )
}

interface CardRowProps {
  item: MarketplaceRepoSummary
  t: MarketplaceTabProps['t']
  expanded: boolean
  detail: MarketplacePluginDetails | undefined
  detailError: string | undefined
  onToggle: () => void
  onInstall: () => void
}

function CardRow({ item, t, expanded, detail, detailError, onToggle, onInstall }: CardRowProps): ReactNode {
  const meta = [
    item.stars > 0 ? '★ ' + item.stars : null,
    item.license !== null ? item.license : null,
    item.language !== null ? item.language : null,
    item.updatedAt !== '' ? t('updated') + ' ' + new Date(item.updatedAt).toLocaleDateString() : null,
  ].filter((value): value is string => value !== null)
  return (
    <li style={s.card}>
      <div style={s.cardBody}>
        <div style={s.titleRow}>
          <strong style={s.title} title={item.fullName}>{item.fullName}</strong>
          <span style={s.tag}>{t('verified')}</span>
        </div>
        <p style={s.description} title={item.description ?? undefined}>{item.description === null || item.description === '' ? '\u00A0' : item.description}</p>
        <div style={s.metaRow}>
          {meta.map((value) => <span key={value} style={s.meta}>{value}</span>)}
          {detail !== undefined && detail.manifest?.hasClient === true ? <span style={s.tag}>{t('hasClient')}</span> : null}
        </div>
        <div style={s.actions}>
          <Button variant='primary' size='sm' onClick={onInstall}>{t('install')}</Button>
          <a style={s.link} href={item.htmlUrl} target='_blank' rel='noreferrer'>{t('openInGithub')}</a>
          <button type='button' style={s.detailToggle} aria-expanded={expanded} onClick={onToggle}>
            {t('details')}
            <IconChevronDownOutline14 size={12} aria-hidden='true' />
          </button>
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
              <dt style={s.kvDt}>{t('verifiedCommit')}</dt>
              <dd style={s.kvDd}>{detail.resolvedRef}</dd>
            </dl>
          ) : null}
          {detail?.patch !== null && detail?.patch !== undefined ? (
            <pre style={s.patch}>{detail.patch}</pre>
          ) : null}
        </div>
      ) : null}
    </li>
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
      {job.log !== '' ? <pre style={s.jobLog}>{job.log}</pre> : null}
    </div>
  )
}
