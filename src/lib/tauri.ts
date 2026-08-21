/**
 * Desktop bridge.
 *
 * Detects whether the app is running inside the Tauri native window or in
 * a plain browser (Vite dev server or static host), and exposes a uniform
 * API. In browser mode every method is a safe no-op (returns the fallback
 * value) so call sites don't have to special-case the two runtimes.
 *
 * This is the ONLY file in the codebase that should import directly from
 * `@tauri-apps/api/*`. Every other consumer goes through one of the
 * wrappers exported below.
 *
 * Why a single bridge file:
 *   - Centralizes the Tauri / browser switch. The rest of the app does
 *     not need to know whether it is running as a desktop binary or a
 *     browser tab.
 *   - Makes it easy to add a mock / stub for unit tests (Vitest targets
 *     this module).
 *   - Keeps the public surface tiny: isDesktop, isBrowser, getAppDataDir,
 *     getAppVersion, getAppName, closeWindow, minimizeWindow,
 *     toggleMaximize. Anything more exotic should live in a feature-
 *     specific module.
 */

// Tauri 2.x exposes a `__TAURI_INTERNALS__` global on `window` when the
// app is running inside the native shell. We use that as the source of
// truth — the `@tauri-apps/api/core` `invoke()` wrapper will throw if
// called outside the shell, so a runtime check first keeps the call
// sites clean.
const TAURI_INTERNALS =
  typeof window !== "undefined" &&
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !==
    undefined;

/** True when the app is running inside the Tauri native window. */
export const isDesktop: boolean = TAURI_INTERNALS;

/** True when the app is running in a plain browser (Vite dev / static host). */
export const isBrowser: boolean = !TAURI_INTERNALS;

/**
 * Lazy invoke. We import `@tauri-apps/api/core` only on the desktop path
 * so the browser bundle stays small and the same code tree-shakes
 * correctly. The import is intentionally dynamic and synchronous in
 * practice because the package is already in the bundle by the time any
 * of these wrappers are called.
 */
export async function safeInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!TAURI_INTERNALS) return null;
  try {
    const mod = await import("@tauri-apps/api/core");
    return await mod.invoke<T>(cmd, args);
  } catch (e) {
    if (typeof console !== "undefined") {
      console.warn(`[tauri] invoke('${cmd}') failed`, e);
    }
    return null;
  }
}

/**
 * The OS-specific per-user app data directory. Tauri resolves this to:
 *   - Windows: %APPDATA%\com.nexuscore.desktop
 *   - macOS:   ~/Library/Application Support/com.nexuscore.desktop
 *   - Linux:   ~/.local/share/com.nexuscore.desktop
 *
 * Returns null in the browser (no app data dir applies there).
 */
export async function getAppDataDir(): Promise<string | null> {
  return await safeInvoke<string>("get_app_data_dir");
}

/** The running app version (mirrors tauri.conf.json). */
export async function getAppVersion(): Promise<string | null> {
  return await safeInvoke<string>("get_app_version");
}

/** The product name (mirrors tauri.conf.json). */
export async function getAppName(): Promise<string | null> {
  return await safeInvoke<string>("get_app_name");
}

/**
 * Close the native window. In the browser we fall back to window.close()
 * which is mostly a no-op (browsers rarely allow it), but the call is
 * safe and matches the intent.
 */
export async function closeWindow(): Promise<void> {
  if (!TAURI_INTERNALS) {
    try {
      window.close();
    } catch {
      // ignore
    }
    return;
  }
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
  } catch (e) {
    console.warn("[tauri] closeWindow failed", e);
  }
}

/** Minimize the native window. No-op in browser. */
export async function minimizeWindow(): Promise<void> {
  if (!TAURI_INTERNALS) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().minimize();
  } catch (e) {
    console.warn("[tauri] minimizeWindow failed", e);
  }
}

/** Toggle maximize. No-op in browser. */
export async function toggleMaximize(): Promise<void> {
  if (!TAURI_INTERNALS) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const w = getCurrentWindow();
    if (await w.isMaximized()) {
      await w.unmaximize();
    } else {
      await w.maximize();
    }
  } catch (e) {
    console.warn("[tauri] toggleMaximize failed", e);
  }
}

/** Best-effort OS detection for both runtimes. */
export type OsKind = "windows" | "macos" | "linux" | "web" | "unknown";

/**
 * Detect the host OS. In the Tauri shell this is exact (via the os
 * plugin's metadata); in the browser it falls back to userAgent sniffing.
 *
 * Note: in the browser the value may be wrong on exotic runtimes
 * (Chromium on Linux will report "linux" — that's fine for our needs).
 */
export function detectOs(): OsKind {
  if (TAURI_INTERNALS) {
    // The os plugin exposes a synchronous `platform()` call. We try it
    // best-effort — if it fails for any reason we fall back to UA.
    try {
      // Dynamic import so the browser bundle does not pull in the plugin
      // shim.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { platform } = require("@tauri-apps/plugin-os") as {
        platform: () => string;
      };
      const p = platform();
      if (p === "windows") return "windows";
      if (p === "macos") return "macos";
      if (p === "linux") return "linux";
    } catch {
      // fall through to UA
    }
  }
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("win")) return "windows";
  if (ua.includes("mac")) return "macos";
  if (ua.includes("linux")) return "linux";
  return "web";
}

/**
 * DEV ONLY. Empties the ledger to a freshly-installed schema.
 *
 * Unlike the wrappers above this one does NOT swallow its error: it is
 * destructive, and a caller that thinks it wiped the database when it did not
 * would start a test round on dirty data — the exact thing it exists to
 * prevent. The Rust side refuses the call in a release build.
 */
export async function devResetLedger(): Promise<void> {
  if (!TAURI_INTERNALS) {
    throw new Error("الأمر ده شغال بس في نسخة سطح المكتب");
  }
  const mod = await import("@tauri-apps/api/core");
  await mod.invoke<void>("dev_reset_ledger");
}

/**
 * Open a link outside the app — WhatsApp, a docs page, a courier's portal.
 *
 * In the desktop shell this hands the URL to the OS (the `shell:allow-open`
 * capability), which is what opens WhatsApp Desktop or the browser. A plain
 * `window.open` is NOT a substitute: the WebView blocks it, exactly as it
 * blocked every PDF export until that was fixed.
 */
export async function openExternal(url: string): Promise<void> {
  if (!TAURI_INTERNALS) {
    window.open(url, "_blank", "noreferrer");
    return;
  }
  const { open } = await import("@tauri-apps/plugin-shell");
  await open(url);
}
