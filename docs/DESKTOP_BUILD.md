# Desktop build & deployment

This document covers the **desktop** build story for NexusCore. The web build is unchanged — `npm run dev` and `npm run build` continue to work exactly as before. Everything below is opt-in and only activates once the Tauri toolchain is installed.

---

## What is in the repo

- `src-tauri/` — the native shell. Rust crate + Tauri 2.x config.
- `src/lib/tauri.ts` — JS-side bridge. Detects desktop vs browser and exposes a uniform API.
- `src/lib/db.ts` — local-DB bridge. Today routes to localStorage in both runtimes; Phase B will swap in SQLite.
- `src/lib/platform.ts` — `platform.isDesktopWindows`, `platform.os`, etc. — read these instead of `navigator.userAgent` checks.
- `package.json` scripts: `tauri:dev`, `tauri:build`, `tauri:icon`, `tauri:setup`.

---

## Browser dev (unchanged)

```bash
npm install
npm run dev      # http://localhost:8080 — pure browser, no Tauri involvement
```

All 15 stores keep using `localStorage`. Everything works exactly as before. The Tauri-aware code in `src/lib/tauri.ts` and `src/lib/db.ts` resolves to no-ops when `window.__TAURI_INTERNALS__` is undefined.

---

## Desktop build (one-time setup)

### 1. Install the toolchain

The desktop build needs:

| Tool | Why | Install (Windows) |
|---|---|---|
| **Rust** (rustc + cargo) | Compiles the native shell | `winget install --id Rustlang.Rustup -e` then `rustup default stable` |
| **MSVC Build Tools** (`cl.exe` + `link.exe`) | Links the Windows binary | `winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"` |
| **WebView2 Runtime** | Renders the React UI inside the native window | Pre-installed on Windows 10 21H2+ and Windows 11. Otherwise: `winget install --id Microsoft.EdgeWebView2Runtime -e` |

> ⚠️ Restart your terminal after installing Rust so `cargo` is on `PATH`. Then run:
>
> ```powershell
> $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
> cargo --version
> rustc --version
> ```

Sanity check before proceeding:

```powershell
cargo --version      # cargo 1.x.x (...)
rustc --version      # rustc 1.x.x (...)
where.exe link.exe   # C:\Program Files (x86)\Microsoft Visual Studio\...
```

### 2. Install JS dependencies

```bash
npm install
```

This pulls in the new Tauri packages:

- `@tauri-apps/api` (runtime bridge)
- `@tauri-apps/cli` (the `tauri` command, devDep)
- `@tauri-apps/plugin-fs`, `plugin-dialog`, `plugin-os`, `plugin-shell` (JS wrappers for the corresponding Rust plugins)

### 3. Generate the app icon

The Tauri build expects icons in `src-tauri/icons/` in multiple sizes (`.ico`, `.icns`, `32x32.png`, `128x128.png`, `128x128@2x.png`, plus the Windows Store variants). The `tauri icon` command generates them all from a single source PNG.

The repo already has a high-quality source at `src/assets/logo-light.png` (1024px). To generate the full icon set:

```bash
npm run tauri:icon
# or, if you don't have a source PNG yet, this will create a placeholder
# first and then expand it:
npm run tauri:setup
```

This populates `src-tauri/icons/` with every required variant. Regenerate any time the logo changes.

### 4. Run the desktop dev loop

```bash
npm run tauri:dev
```

This boots:
- the Vite dev server (port 8080)
- the Rust compiler (incremental, fast)
- a native window that loads `http://localhost:8080` and watches the file system

HMR works as in browser mode. Edits to React, CSS, and TypeScript files reload the window instantly. Edits to Rust files (under `src-tauri/`) trigger a Rust rebuild — the window reopens automatically.

### 5. Build the production binary

```bash
npm run tauri:build
```

Output:
- `src-tauri/target/release/nexuscore-desktop.exe` — standalone portable binary
- `src-tauri/target/release/bundle/nsis/NexusCore_1.0.0_x64-setup.exe` — NSIS installer (per-machine install, with Arabic + English language packs, language selector on first launch)
- `src-tauri/target/release/bundle/msi/NexusCore_1.0.0_x64_en-US.msi` — WiX MSI installer (for managed enterprise deploys)

The NSIS installer is the default. It registers the app in Add/Remove Programs, creates a Start Menu shortcut, and respects the existing `path/to/existing/install` for upgrades.

The build is fully offline once the toolchain is installed — no live network calls during the build itself.

---

## How the bridge works

`src/lib/tauri.ts` is the only file that imports from `@tauri-apps/api/*`. Every other consumer goes through one of these wrappers:

| Function | Browser | Desktop |
|---|---|---|
| `isDesktop` | `false` | `true` |
| `isBrowser` | `true` | `false` |
| `getAppDataDir()` | `null` | e.g. `C:\Users\<user>\AppData\Roaming\com.nexuscore.desktop` |
| `getAppVersion()` | `"0.0.0-browser"` | `"1.0.0"` |
| `getAppName()` | `null` | `"NexusCore"` |
| `closeWindow()` | `window.close()` (mostly no-op) | closes the native window |
| `minimizeWindow()` | no-op | minimizes the native window |
| `toggleMaximize()` | no-op | toggles maximize on the native window |
| `detectOs()` | UA sniffing | `tauri-plugin-os` (`windows` / `macos` / `linux`) |

Anything that needs a real OS path (e.g. the backup export flow pointing at `Downloads\NexusCore-…json` instead of triggering a browser download) should call `getAppDataDir()` first and fall back to the browser flow if it returns `null`.

---

## Where Phase B lands

`src/lib/db.ts` is a stub today. Phase B will:

1. Add `tauri-plugin-sql` to `src-tauri/Cargo.toml`.
2. Register it in `src-tauri/src/lib.rs` and add a Tauri command that runs SQL against a SQLite file at `<app_data_dir>/nexuscore.db`.
3. Replace the body of `dbStorage` in `src/lib/db.ts` with a Tauri-SQLite-backed implementation.
4. Swap the `persist` middleware in each Zustand store to consume `dbStorage`.

The contract is stable: the new implementation honors `getItem` / `setItem` / `removeItem` with the same semantics as `localStorage`. Stores won't need to change their schemas — just their storage adapter.

---

## Where Phase C lands

`tauri build` already produces the NSIS installer. Phase C will:

1. Add `tauri-plugin-updater` to wire auto-update from a release channel.
2. Add a `tauri.conf.json` `updater` block pointing at the GitHub releases endpoint.
3. Add a "Check for updates" button on the Settings page that calls `invoke('plugin:updater|check')`.

For now, the build produces the installer; the in-app updater hookup is a Phase C concern.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `cargo: command not found` after install | Re-open the terminal so the new `PATH` is picked up. On Windows: `$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')` |
| `link.exe not found` during `tauri build` | MSVC Build Tools not installed (or installed without the C++ workload). Re-run the winget command above and reboot. |
| `tauri icon` fails with "PNG must be at least 1024x1024" | Re-export `src/assets/logo-light.png` from the source design at 1024px square. |
| Build error: `failed to run custom build command for tauri-build` | Usually means MSVC C++ workload is missing. Reinstall with the C++ workload. |
| WebView2 blank window | WebView2 runtime missing on this Windows version. Install via the winget command above. |
| Vite HMR broke after switching to Tauri | Run plain `npm run dev` to confirm Vite is healthy. If it works, the Tauri config in `src-tauri/tauri.conf.json` is the suspect — verify `devUrl` matches Vite's `server.port`. |
