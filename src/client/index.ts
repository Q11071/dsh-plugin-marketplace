/** Plugin marketplace, browser half: the `marketplace` settings tab.
 *  Registers into the Plugins settings section through the
 *  settings.plugins.tab slot and mounts this package's own Remote
 *  contribution, mirroring ui-settings-plugin-inventory.
 */

import type {} from '@deepseek-ai/dsh-client-locale/client'
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
export const inject = ['remote']

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

  ctx.inject(['slots', 'locale', 'remote', 'remote.marketplace'], (scope: ClientContext) => {
    scope.effect(() => scope.locale.register(NS, { zh, en }), 'plugin-marketplace: dictionaries')

    const t = scope.locale.bind(NS)
    const injected = (): MarketplaceTabInjected => ({
      search: async (query, page, sort) => unwrapMarketplace(await scope.remote.marketplace.search({ query, page, sort })),
      details: async (repo, ref) => unwrapMarketplace(await scope.remote.marketplace.details({ repo, ref })),
      install: async (repo, ref) => unwrapMarketplace(await scope.remote.marketplace.installPlugin({ repo, ref })).jobId,
      update: async (repo, ref) => unwrapMarketplace(await scope.remote.marketplace.update({ repo, ref })).jobId,
      uninstall: async (packageName) => unwrapMarketplace(await scope.remote.marketplace.uninstall({ packageName })).jobId,
      setEnabled: async (packageName, enabled) => unwrapMarketplace(await scope.remote.marketplace.setEnabled({ packageName, enabled })),
      jobStatus: async (jobId) => unwrapMarketplace(await scope.remote.marketplace.jobStatus({ jobId })),
      installed: async () => unwrapMarketplace(await scope.remote.marketplace.installed()),
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

// The injected face types below keep the closures checked without pulling
// extra value imports into the client bundle.
export type {
  MarketplaceInstallRequest,
  MarketplaceInstalledEntry,
  MarketplaceInstalled,
  MarketplaceJobStatus,
  MarketplacePluginDetails,
  MarketplaceSearchPage,
} from '../types.ts'
