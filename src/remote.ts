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
  MarketplaceDiagnoseConflictsResult,
  MarketplaceGuidedAgentRequest,
  MarketplaceGuidedAgentTask,
  MarketplaceInstallDirRequest,
  MarketplaceInstallLocation,
  MarketplaceInstallRequest,
  MarketplaceManualInstallRequest,
  MarketplaceManualInstallResult,
  MarketplaceInstalled,
  MarketplaceJobHandle,
  MarketplaceJobStatus,
  MarketplaceJobStatusRequest,
  MarketplacePluginDetails,
  MarketplaceResult,
  MarketplaceRestartResult,
  MarketplaceSearchPage,
  MarketplaceSearchRequest,
  MarketplaceUninstallRequest,
  MarketplaceToggleRequest,
  MarketplaceToggleResult,
} from './types.ts'

export type { MarketplaceJobHandle } from './types.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$6d61726b6574706c616365 {
    search: (request: MarketplaceSearchRequest) => Promise<RemoteResult<MarketplaceResult<MarketplaceSearchPage>>>
    details: (request: MarketplaceDetailsRequest) => Promise<RemoteResult<MarketplaceResult<MarketplacePluginDetails>>>
    guidedTask: (request: MarketplaceGuidedAgentRequest) => Promise<RemoteResult<MarketplaceResult<MarketplaceGuidedAgentTask>>>
    installPlugin: (request: MarketplaceInstallRequest) => Promise<RemoteResult<MarketplaceResult<MarketplaceJobHandle>>>
    manualInstall: (request: MarketplaceManualInstallRequest) => Promise<RemoteResult<MarketplaceResult<MarketplaceManualInstallResult>>>
    update: (request: MarketplaceInstallRequest) => Promise<RemoteResult<MarketplaceResult<MarketplaceJobHandle>>>
    uninstall: (request: MarketplaceUninstallRequest) => Promise<RemoteResult<MarketplaceResult<MarketplaceJobHandle>>>
    setEnabled: (request: MarketplaceToggleRequest) => Promise<RemoteResult<MarketplaceResult<MarketplaceToggleResult>>>
    jobStatus: (request: MarketplaceJobStatusRequest) => Promise<RemoteResult<MarketplaceResult<MarketplaceJobStatus>>>
    installed: () => Promise<RemoteResult<MarketplaceResult<MarketplaceInstalled>>>
    installLocation: () => Promise<RemoteResult<MarketplaceResult<MarketplaceInstallLocation>>>
    setInstallDir: (request: MarketplaceInstallDirRequest) => Promise<RemoteResult<MarketplaceResult<MarketplaceInstallLocation>>>
    diagnoseConflicts: () => Promise<RemoteResult<MarketplaceResult<MarketplaceDiagnoseConflictsResult>>>
    restart: () => Promise<RemoteResult<MarketplaceResult<MarketplaceRestartResult>>>
  }
  interface TypertRemoteMap {
    'marketplace/search': (request: MarketplaceSearchRequest) => Promise<RemoteResult<MarketplaceResult<MarketplaceSearchPage>>>
    'marketplace/details': (request: MarketplaceDetailsRequest) => Promise<RemoteResult<MarketplaceResult<MarketplacePluginDetails>>>
    'marketplace/guidedTask': (request: MarketplaceGuidedAgentRequest) => Promise<RemoteResult<MarketplaceResult<MarketplaceGuidedAgentTask>>>
    'marketplace/installPlugin': (request: MarketplaceInstallRequest) => Promise<RemoteResult<MarketplaceResult<MarketplaceJobHandle>>>
    'marketplace/manualInstall': (request: MarketplaceManualInstallRequest) => Promise<RemoteResult<MarketplaceResult<MarketplaceManualInstallResult>>>
    'marketplace/update': (request: MarketplaceInstallRequest) => Promise<RemoteResult<MarketplaceResult<MarketplaceJobHandle>>>
    'marketplace/uninstall': (request: MarketplaceUninstallRequest) => Promise<RemoteResult<MarketplaceResult<MarketplaceJobHandle>>>
    'marketplace/setEnabled': (request: MarketplaceToggleRequest) => Promise<RemoteResult<MarketplaceResult<MarketplaceToggleResult>>>
    'marketplace/jobStatus': (request: MarketplaceJobStatusRequest) => Promise<RemoteResult<MarketplaceResult<MarketplaceJobStatus>>>
    'marketplace/installed': () => Promise<RemoteResult<MarketplaceResult<MarketplaceInstalled>>>
    'marketplace/installLocation': () => Promise<RemoteResult<MarketplaceResult<MarketplaceInstallLocation>>>
    'marketplace/setInstallDir': (request: MarketplaceInstallDirRequest) => Promise<RemoteResult<MarketplaceResult<MarketplaceInstallLocation>>>
    'marketplace/diagnoseConflicts': () => Promise<RemoteResult<MarketplaceResult<MarketplaceDiagnoseConflictsResult>>>
    'marketplace/restart': () => Promise<RemoteResult<MarketplaceResult<MarketplaceRestartResult>>>
  }
  interface TypertRemoteNamespaceMap {
    marketplace: TypertRemoteNamespace$6d61726b6574706c616365
  }
}

import { TYPERT_REMOTE } from './wire.ts'

export { TYPERT_REMOTE }
export default TYPERT_REMOTE
