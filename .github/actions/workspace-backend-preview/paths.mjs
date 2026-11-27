const frontendOnlyPrefix = "apps/deskohub-workspace/";

// The production image builds from the repository root and uses Turbo's
// transitive workspace closure. Unknown paths must require a generation.
export function backendGenerationRequired(changedPaths) {
  return changedPaths.some((path) => !path.startsWith(frontendOnlyPrefix));
}
