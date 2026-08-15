/** Pure bundle-layer state transitions shared by profile persistence and tests. */

export function reconcileBundleName(
  currentBundles: readonly string[],
  packageName: string,
  beforeDependency: boolean,
  beforeDeclaresBundle: boolean,
  dependency: boolean,
  declaresBundle: boolean,
): string[] {
  const bundles = [...currentBundles]
  const index = bundles.indexOf(packageName)
  const newlyInstallableBundle = dependency && declaresBundle
    && (!beforeDependency || !beforeDeclaresBundle)
  if (newlyInstallableBundle && index < 0) bundles.push(packageName)
  const managedDependency = beforeDependency || dependency
  if (managedDependency && (!dependency || !declaresBundle) && index >= 0) bundles.splice(index, 1)
  return bundles
}

export function toggleBundleName(currentBundles: readonly string[], packageName: string, enabled: boolean): string[] {
  const bundles = [...currentBundles]
  const index = bundles.indexOf(packageName)
  if (enabled && index < 0) bundles.push(packageName)
  if (!enabled && index >= 0) bundles.splice(index, 1)
  return bundles
}
