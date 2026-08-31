/**
 * App version — single source of truth.
 *
 * Keep this in sync with `package.json`.
 * The build pipeline does not currently inject this automatically; a
 * pre-release script can grep-and-replace it as part of release prep
 * (see docs/RELEASING.md, to be added in Phase C).
 *
 * Why a constant and not a dynamic read:
 *   - The build never changes the version mid-runtime.
 *   - Importing `package.json` directly requires resolveJsonModule and
 *     bloats the bundle.
 *   - It is what the runtime UI displays.
 */

export const APP_VERSION = "1.0.0";
export const APP_VERSION_MAJOR = 1;
export const APP_VERSION_MINOR = 0;
export const APP_VERSION_PATCH = 0;

/**
 * Parse a "x.y.z" version string. Returns [0,0,0] for unparseable input
 * so the backup-compat check degrades gracefully.
 */
export function parseVersion(v: string | null | undefined): [number, number, number] {
  if (!v || typeof v !== "string") return [0, 0, 0];
  const parts = v.split(".").map((p) => parseInt(p, 10));
  return [
    Number.isFinite(parts[0]) ? parts[0] : 0,
    Number.isFinite(parts[1]) ? parts[1] : 0,
    Number.isFinite(parts[2]) ? parts[2] : 0,
  ];
}

export type VersionCompatResult =
  | { kind: "same"; message: string }
  | { kind: "compatible_older"; message: string }
  | { kind: "compatible_newer"; message: string }
  | { kind: "incompatible_older"; message: string }
  | { kind: "incompatible_newer"; message: string }
  | { kind: "unknown"; message: string };

/**
 * Check whether a backup bundle (version `bundleVersion`) is safe to
 * restore into the current app (`APP_VERSION`).
 *
 * Compatibility rule:
 *   - Same major: compatible (with soft notice on minor drift).
 *   - Older major: incompatible — schema likely broke.
 *   - Newer major: incompatible — bundle was created by a newer app
 *     that may use fields the current app doesn't understand.
 *   - Unparseable: unknown — block the restore with an explicit
 *     warning so the admin decides.
 */
export function checkBackupVersionCompat(bundleVersion: string | null | undefined): VersionCompatResult {
  const [bmaj, bmin] = parseVersion(bundleVersion);
  if (bmaj === 0) {
    return {
      kind: "unknown",
      message:
        "تعذّر قراءة إصدار النسخة الاحتياطية. قد يكون الملف تالفاً أو من إصدار غير معروف. أكّد المتابعة على مسؤوليتك.",
    };
  }
  if (bmaj === APP_VERSION_MAJOR) {
    if (bmin > APP_VERSION_MINOR) {
      return {
        kind: "compatible_newer",
        message: `النسخة من إصدار ${bundleVersion} (أحدث من ${APP_VERSION}). الاستعادة آمنة لكن بعض البيانات الجديدة قد تُتجاهَل.`,
      };
    }
    if (bmin < APP_VERSION_MINOR) {
      return {
        kind: "compatible_older",
        message: `النسخة من إصدار ${bundleVersion} (أقدم من ${APP_VERSION}). الاستعادة آمنة.`,
      };
    }
    return { kind: "same", message: `نفس إصدار التطبيق (${APP_VERSION}).` };
  }
  if (bmaj < APP_VERSION_MAJOR) {
    return {
      kind: "incompatible_older",
      message: `النسخة من إصدار رئيسي أقدم (${bundleVersion} vs ${APP_VERSION}). قد تفشل الاستعادة بسبب تغيّر في مخطط البيانات.`,
    };
  }
  return {
    kind: "incompatible_newer",
    message: `النسخة من إصدار رئيسي أحدث (${bundleVersion} vs ${APP_VERSION}). لن يفهمها هذا الإصدار من التطبيق.`,
  };
}
