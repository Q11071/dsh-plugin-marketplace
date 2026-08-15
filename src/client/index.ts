/** Plugin marketplace, browser half: the `marketplace` settings tab.
 *  Registers into the Plugins settings section through the
 *  settings.plugins.tab slot and mounts this package's own Remote
 *  contribution, mirroring ui-settings-plugin-inventory.
 */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { MarketplaceResult } from '../types.ts'
import { TYPERT_REMOTE } from '../remote.ts'
import { MarketplaceTab, type MarketplaceTabInjected } from './MarketplaceTab.tsx'
import { en, zh, type PluginMarketplaceLocaleKey } from './locales.ts'

export type { MarketplaceTabInjected, MarketplaceTabProps } from './MarketplaceTab.tsx'
export type { PluginMarketplaceLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Plugin marketplace copy. */
    'settings.pluginMarketplace': PluginMarketplaceLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.pluginMarketplace'

/** Service required before this plugin can mount its own Remote namespace. */
export const inject = ['remote', 'connection']

/** Unwrap a RemoteResult into its value; failures throw for the UI. */
function unwrap<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** Unwrap the transport result followed by the marketplace business outcome. */
function unwrapMarketplace<T>(result: RemoteResult<MarketplaceResult<T>>): T {
  return unwrap(unwrap(result))
}

/** Mount the marketplace Remote contribution, then register its Settings tab. */
export async function apply(ctx: ClientContext): Promise<void> {
  const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE)
  ctx.effect(() => disposeRemote, 'plugin-marketplace: remote lifetime')

  ctx.inject(['slots', 'locale', 'remote', 'remote.marketplace', 'connection', 'sessions', 'workspaces'], (scope: ClientContext) => {
    scope.effect(() => scope.locale.register(NS, { zh, en }), 'plugin-marketplace: dictionaries')

    const t = scope.locale.bind(NS)
    const { api } = scope.get('connection') as ConnectionHandle
    const injected = (): MarketplaceTabInjected => ({
      search: async (query, page, sort, category) => unwrapMarketplace(await scope.remote.marketplace.search({ query, page, sort, category })),
      details: async (repo, ref) => unwrapMarketplace(await scope.remote.marketplace.details({ repo, ref })),
      guidedAgent: async (repo, ref, operation) => {
        const task = unwrapMarketplace(await scope.remote.marketplace.guidedTask({ repo, ref, operation }))
        const workspaces = scope.workspaces.list.getSnapshot()
        const sessions = scope.sessions.list.getSnapshot()
        const currentSessionId = sessions.current
        const currentWorkspace = currentSessionId === undefined
          ? undefined
          : workspaces.items.find(workspace => workspace.sessionIds.includes(currentSessionId))
        const target = currentWorkspace
          ?? workspaces.items.find(workspace => workspace.workspaceId === workspaces.recentWorkspaceId)
          ?? workspaces.items[0]
        if (target === undefined) throw new Error(t('agentWorkspaceRequired'))

        const roster = await api.agentPresets.list({})
        if (!roster.result.ok) throw new Error(roster.result.error.message)
        const usable = roster.result.value.presets.filter(preset => preset.broken === undefined)
        const preset = usable.find(candidate => candidate.id === 'standard')
          ?? usable.find(candidate => candidate.id === 'code')
          ?? usable.find(candidate => candidate.isDefault)
        if (preset === undefined) throw new Error(t('agentPresetUnavailable'))

        const created = await api.sessions.create({ workspaceId: target.workspaceId, agentPreset: preset.id })
        if (!created.result.ok) throw new Error(created.result.error.message)
        const binding = await waitForBinding(scope, created.result.value.sessionId)
        await binding.session.rename(task.title)
        const prompted = await binding.session.prompt([{ type: 'text', text: task.prompt }], 'queue')
        if (!prompted.ok) throw new Error(prompted.error.message)
        scope.sessions.open(created.result.value.sessionId)
      },
      install: async (repo, ref) => unwrapMarketplace(await scope.remote.marketplace.installPlugin({ repo, ref })).jobId,
      manualInstall: async (command) => unwrapMarketplace(await scope.remote.marketplace.manualInstall({ command })),
      update: async (repo, ref) => unwrapMarketplace(await scope.remote.marketplace.update({ repo, ref })).jobId,
      uninstall: async (packageName) => unwrapMarketplace(await scope.remote.marketplace.uninstall({ packageName })).jobId,
      setEnabled: async (packageName, enabled) => unwrapMarketplace(await scope.remote.marketplace.setEnabled({ packageName, enabled })),
      installLocation: async () => unwrapMarketplace(await scope.remote.marketplace.installLocation()),
      setInstallDir: async (installDir) => unwrapMarketplace(await scope.remote.marketplace.setInstallDir({ installDir })),
      chooseInstallDir: async () => {
        try {
          return await scope.workspaces.pickDirectory()
        } catch (error) {
          throw new Error(t('installDirPickerFailed') + ': ' + (error instanceof Error ? error.message : String(error)))
        }
      },
      diagnoseConflicts: async () => unwrapMarketplace(await scope.remote.marketplace.diagnoseConflicts()),
      jobStatus: async (jobId) => unwrapMarketplace(await scope.remote.marketplace.jobStatus({ jobId })),
      installed: async () => unwrapMarketplace(await scope.remote.marketplace.installed()),
      restart: async () => unwrapMarketplace(await scope.remote.marketplace.restart()),
    })

    scope.slots.inject('settings.plugins.tab', () => scope.slots.register({
      name: 'settings.plugins.tab',
      id: 'marketplace',
      order: 20,
      label: () => t('tab'),
      locale: NS,
      inject: injected,
    }, MarketplaceTab))
  })
}

/** Wait for the runtime's Host stream to project a directly-created Agent session. */
function waitForBinding(ctx: ClientContext, sessionId: Parameters<ClientContext['sessions']['open']>[0]) {
  const ready = ctx.sessions.binding(sessionId)
  if (ready !== undefined) return Promise.resolve(ready)
  return new Promise<NonNullable<ReturnType<ClientContext['sessions']['binding']>>>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      unsubscribe()
      reject(new Error('The Agent session was created, but it did not appear in the client before the timeout.'))
    }, 10_000)
    const unsubscribe = ctx.sessions.list.subscribe(() => {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) return
      window.clearTimeout(timeout)
      unsubscribe()
      resolve(binding)
    })
  })
}

// The injected face types below keep the closures checked without pulling
// extra value imports into the client bundle.
export type {
  MarketplaceInstallRequest,
  MarketplaceInstalledEntry,
  MarketplaceInstalled,
  MarketplaceJobStatus,
  MarketplacePluginDetails,
  MarketplaceRestartResult,
  MarketplaceSearchPage,
} from '../types.ts'
