/** Client-side typert remote contribution (package export `./remote`).
 *  The client bundle inlines this module and mounts it with
 *  ctx.remote.$mount(...), which provides the typed `marketplace`
 *  namespace. The declaration merges mirror the generated artifact
 *  shape (interface names are arbitrary; the map keys are the contract).
 */

import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  MarketplaceDetailsRequest,
  MarketplaceInstallRequest,
  MarketplaceInstalled,
  MarketplaceJobHandle,
  MarketplaceJobStatus,
  MarketplaceJobStatusRequest,
  MarketplacePluginDetails,
  MarketplaceResult,
  MarketplaceSearchPage,
  MarketplaceSearchRequest,
  MarketplaceUninstallRequest,
} from './types.ts'

export type { MarketplaceJobHandle } from './types.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$6d61726b6574706c616365 {
    search: (request: MarketplaceSearchRequest) => Promise<RemoteResult<MarketplaceResult<MarketplaceSearchPage>>>
    details: (request: MarketplaceDetailsRequest) => Promise<RemoteResult<MarketplaceResult<MarketplacePluginDetails>>>
    installPlugin: (request: MarketplaceInstallRequest) => Promise<RemoteResult<MarketplaceResult<MarketplaceJobHandle>>>
    update: (request: MarketplaceInstallRequest) => Promise<RemoteResult<MarketplaceResult<MarketplaceJobHandle>>>
    uninstall: (request: MarketplaceUninstallRequest) => Promise<RemoteResult<MarketplaceResult<MarketplaceJobHandle>>>
    jobStatus: (request: MarketplaceJobStatusRequest) => Promise<RemoteResult<MarketplaceResult<MarketplaceJobStatus>>>
    installed: () => Promise<RemoteResult<MarketplaceResult<MarketplaceInstalled>>>
  }
  interface TypertRemoteMap {
    'marketplace/search': (request: MarketplaceSearchRequest) => Promise<RemoteResult<MarketplaceResult<MarketplaceSearchPage>>>
    'marketplace/details': (request: MarketplaceDetailsRequest) => Promise<RemoteResult<MarketplaceResult<MarketplacePluginDetails>>>
    'marketplace/installPlugin': (request: MarketplaceInstallRequest) => Promise<RemoteResult<MarketplaceResult<MarketplaceJobHandle>>>
    'marketplace/update': (request: MarketplaceInstallRequest) => Promise<RemoteResult<MarketplaceResult<MarketplaceJobHandle>>>
    'marketplace/uninstall': (request: MarketplaceUninstallRequest) => Promise<RemoteResult<MarketplaceResult<MarketplaceJobHandle>>>
    'marketplace/jobStatus': (request: MarketplaceJobStatusRequest) => Promise<RemoteResult<MarketplaceResult<MarketplaceJobStatus>>>
    'marketplace/installed': () => Promise<RemoteResult<MarketplaceResult<MarketplaceInstalled>>>
  }
  interface TypertRemoteNamespaceMap {
    marketplace: TypertRemoteNamespace$6d61726b6574706c616365
  }
}

import { TYPERT_REMOTE } from './wire.ts'

export { TYPERT_REMOTE }
export default TYPERT_REMOTE
