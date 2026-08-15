/** Bind a guided Agent to the exact Workspace selected by the marketplace Host. */

export interface AgentWorkspaceCreator<T> {
  create(input: { path: string }): Promise<T>
}

export async function createGuidedAgentWorkspace<T>(
  workspaces: AgentWorkspaceCreator<T>,
  workspaceDir: string,
): Promise<T> {
  if (workspaceDir.trim() === '') throw new Error('The guided Agent task has no workspace path.')
  return workspaces.create({ path: workspaceDir })
}
