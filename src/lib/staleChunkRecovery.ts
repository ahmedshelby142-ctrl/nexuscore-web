/**
 * Recover once from a Vite chunk that disappeared during a deployment.
 *
 * The session-scoped flag prevents an offline or malformed deployment from
 * causing a reload loop. Both Vite entry points install this exact behavior.
 */
export function installStaleChunkRecovery(): void {
  window.addEventListener("vite:preloadError", (event) => {
    const reloadOnce = "nexus-chunk-reload";
    if (sessionStorage.getItem(reloadOnce)) return;
    try {
      sessionStorage.setItem(reloadOnce, String(Date.now()));
    } catch {
      return;
    }
    event.preventDefault();
    window.location.reload();
  });
}
