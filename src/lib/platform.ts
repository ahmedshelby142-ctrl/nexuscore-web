/**
 * Platform abstraction.
 *
 * A thin re-export of the desktop-bridge primitives, plus a couple of
 * derived booleans that read better at call sites than
 * `isDesktop && detectOs() === "windows"`.
 *
 * Example:
 *   import { platform } from "@/lib/platform";
 *   if (platform.isDesktopWindows) showInstallerHint();
 */

import { isDesktop, isBrowser, detectOs, type OsKind } from "./tauri";

export type { OsKind } from "./tauri";

export const platform = {
  isDesktop,
  isBrowser,
  os: detectOs(),

  get isWindows(): boolean {
    return detectOs() === "windows";
  },
  get isMacos(): boolean {
    return detectOs() === "macos";
  },
  get isLinux(): boolean {
    return detectOs() === "linux";
  },
  get isWeb(): boolean {
    return isBrowser;
  },
  get isDesktopWindows(): boolean {
    return isDesktop && detectOs() === "windows";
  },
  get isDesktopMacos(): boolean {
    return isDesktop && detectOs() === "macos";
  },
  get isDesktopLinux(): boolean {
    return isDesktop && detectOs() === "linux";
  },
} as const;

export type Platform = typeof platform;
