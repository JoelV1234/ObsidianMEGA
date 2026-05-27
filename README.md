# MEGA Sync

An Obsidian plugin that keeps a vault in two-way sync with a folder in [MEGA](https://mega.nz) cloud storage. Built for mobile and other platforms where FUSE-based MEGA sync clients aren't available.

While the vault is open, local edits stream up to MEGA in real time. On **startup**, the plugin reconciles by treating the MEGA folder as the source of truth — anything that diverged while the vault was closed gets resolved in MEGA's favor.

---

## Requirements

- An Obsidian vault that is empty on first setup (besides the `.obsidian` config folder).
- A MEGA account and an existing folder in MEGA to sync against.

---

## Setup

1. Install and enable the plugin.
2. Open the plugin's settings tab and start setup.
3. Enter your MEGA email + password.
4. Pick a remote folder.
5. The plugin saves your credentials encrypted (see [src/crypto.ts](src/crypto.ts)) and kicks off the first sync.

After setup, your credentials live in [`data.json`](data.json) alongside the sync cache.

---

## How syncing works

Sync runs in two phases that handle different situations.

### 1. Startup reconciliation (MEGA → Local)

Runs **every time you open the vault**. This is the only time MEGA gets to overwrite local state, and it's how the plugin recovers from any drift that happened while the vault was closed (edits from other devices, the MEGA web UI, another machine running this plugin, etc.).

1. The plugin shows a full-screen "Syncing…" overlay and disables vault interaction.
2. It lists every file and folder in your remote MEGA folder (metadata only, no downloads).
3. For each remote file, it decides: **download it, or skip it?** (see [Change detection](#change-detection) below.)
4. It downloads anything that's new or changed.
5. It **deletes any local file or folder that doesn't exist in MEGA**, with one exception: `.obsidian/` is left alone so your plugin settings, hotkeys, and other vault config survive.
6. The overlay closes and the live watcher starts.

The relevant code is `runInitialSync` in [src/sync-engine.ts](src/sync-engine.ts).

### 2. Live watcher (Local → MEGA)

Runs **while the vault is open**, after the startup sync completes.

The plugin subscribes to Obsidian's `create`, `modify`, `delete`, and `rename` events and pushes each change to MEGA through a serial queue (no two operations overlap). The status bar shows what's in flight.

The relevant code is `startWatching` and the `handle*` methods in [src/sync-engine.ts](src/sync-engine.ts).

### What's ignored

Files under these prefixes are never uploaded, downloaded, or deleted:

- `.obsidian/` — your vault config
- `.trash/` — Obsidian's local trash

---

## Change detection

The slow part of any sync is transferring bytes. To avoid re-downloading files that haven't changed, the plugin keeps a small cache called the **sync index**.

### The cache

The sync index lives inside [`data.json`](data.json) under the `syncIndex` key. It's a dictionary keyed by vault-relative file path. One entry per file:

```json
"notes/foo.md": {
  "remoteNodeId": "OFoj0ajD",
  "remoteSize":   16,
  "localSize":    16,
  "localMtime":   1779851293740
}
```

| Field | What it records |
| --- | --- |
| `remoteNodeId` | The unique ID MEGA assigned to this file the last time we downloaded it. MEGA mints a fresh ID whenever a file's bytes are replaced. |
| `remoteSize` | The file's size in MEGA at that moment, in bytes. |
| `localSize` | The file's size on disk right after we wrote it, in bytes. |
| `localMtime` | The OS modification timestamp on disk right after we wrote it (ms since epoch). |

Each entry is roughly 100 bytes. A 10,000-file vault costs ~1 MB of cache.

### The skip rule

For every remote file encountered during a startup sync, the engine looks up its entry in the cache and checks **all four** of:

1. Cached `remoteNodeId` matches the file's current MEGA node ID.
2. Cached `remoteSize` matches the file's current MEGA size.
3. Cached `localSize` matches the file's current on-disk size.
4. Cached `localMtime` matches the file's current on-disk mtime.

If all four match, the on-disk file is **definitely** the same one MEGA has, so the download is skipped. If any of the four differs, the file is downloaded from MEGA and the cache entry is refreshed.

The remote-side checks catch changes made on other devices or via the MEGA web UI. The local-side checks catch tampering with files while the plugin wasn't running. Together they enforce the startup-reconciliation rule: anything that doesn't match what we last downloaded gets resolved by pulling MEGA's version.

The skip logic is `canSkipDownload` in [src/sync-engine.ts](src/sync-engine.ts).

### Why the cache is empty the first time

Right after setup, `syncIndex` has no entries, so every remote file is treated as "no cache → download." This is the slow startup — every byte comes down once. After that initial pass, the cache is fully populated and subsequent startups skip every unchanged file.

If you ever want to force a full re-download, delete `syncIndex` from `data.json` (or delete the file entirely and re-run setup).

---

## Known caveats

- **Startup reconciliation favors MEGA, destructively.** Any file you created or edited while Obsidian was closed gets wiped if it isn't also in MEGA. Only edits made *during* a session — when the live watcher is running — are pushed up. If you want to preserve offline edits, open Obsidian and let the session sync them before closing.
- **Files edited during a session re-download once on next startup.** The watcher uploads them to MEGA, which assigns them a new node ID, but the cache isn't updated to reflect that. The next startup sees a node-ID mismatch and re-fetches the file. The download is wasted but the result is correct.
- **`.obsidian/` is never synced.** Plugin lists, hotkeys, themes, and so on stay device-local.
- **Credentials live on disk.** They're encrypted with a local key (see [src/crypto.ts](src/crypto.ts)), but the key is also stored locally — this protects against casual inspection of `data.json`, not against an attacker with filesystem access.

---

## File layout

| Path | Role |
| --- | --- |
| [src/main.ts](src/main.ts) | Plugin entry. Owns settings, the overlay, the status bar, and the startup flow. |
| [src/sync-engine.ts](src/sync-engine.ts) | Sync logic — startup reconciliation, change detection, live watcher event handling. |
| [src/mega-client.ts](src/mega-client.ts) | Thin wrapper around the `megajs` library: login, walk, download, upload, delete. |
| [src/crypto.ts](src/crypto.ts) | Symmetric encryption for the stored password. |
| [src/setup-modal.ts](src/setup-modal.ts) | First-run wizard: credentials + folder picker. |
| [src/settings-tab.ts](src/settings-tab.ts) | Obsidian settings panel. |
| [src/sync-overlay.ts](src/sync-overlay.ts) | Full-screen lockout shown during initial sync. |
| [src/confirm-modal.ts](src/confirm-modal.ts) | Generic yes/no modal for destructive actions. |
| [src/types.ts](src/types.ts) | Shared type definitions including the sync index entry shape. |
| [data.json](data.json) | Persistent state: settings, encrypted credentials, sync index. |

---

## Development

```bash
npm install
node esbuild.config.mjs          # one-off build
node esbuild.config.mjs --watch  # rebuild on change
node esbuild.config.mjs production
```

The bundled output is `main.js`, which Obsidian loads at runtime.
