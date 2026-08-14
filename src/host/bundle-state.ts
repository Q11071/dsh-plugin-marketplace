/** Pure bundle-layer state transitions shared by profile persistence and tests. */

export function reconcileBundleNames(
  beforeDependencies: Iterable<string>,
  dependencies: Iterable<string>,
  currentBundles: readonly string[],
  declaresBundle: (packageName: string) => boolean,
): string[] {
  const before = new Set(beforeDependencies)
  const after = new Set(dependencies)
  const bundles = [...currentBundles]
  for (const packageName of after) {
    if (declaresBundle(packageName) && !bundles.includes(packageName) && !before.has(packageName)) {
      bundles.push(packageName)
    }
  }
  for (const packageName of [...bundles]) {
    const wasDependency = before.has(packageName) || after.has(packageName)
    const stillBundle = after.has(packageName) && declaresBundle(packageName)
    if (wasDependency && !stillBundle) bundles.splice(bundles.indexOf(packageName), 1)
  }
  return bundles
}

export function toggleBundleName(currentBundles: readonly string[], packageName: string, enabled: boolean): string[] {
  const bundles = [...currentBundles]
  const index = bundles.indexOf(packageName)
  if (enabled && index < 0) bundles.push(packageName)
  if (!enabled && index >= 0) bundles.splice(index, 1)
  return bundles
}
