# Seerr Request Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Seerr fork whose Requests page shows live per-episode download state pushed over SSE and lets every user Prioritize, Pause/Resume and Delete/Restore a request, season or episode, with a dedicated Play on Plex button.

**Architecture:** A server-side `liveStatus` module merges Sonarr/Radarr state (SignalR events + REST), Transmission RPC (polled every 2 s only while an SSE client is connected) and new per-item control rows into a snapshot per request; diffs are streamed to the browser over `text/event-stream`. A `requestControls` module executes actions against Sonarr/Radarr/Transmission and records paused/deleted state in a new table; upstream request flows consult that table so paused/deleted items never come back on their own. The Requests page renders an expandable card (mockup A v2) driven by the stream.

**Tech Stack:** Seerr v3.5.1 (Node 22, Express 5, TypeORM 0.3 on SQLite/Postgres, Next.js 16, React 19, SWR, Tailwind 3, react-intl), `node:test` + supertest, `@microsoft/signalr`, pnpm 10, GitHub Actions → ghcr.io.

**Spec:** `docs/superpowers/specs/2026-10-25-seerr-request-controls-design.md` (copied into the fork in Task 1). Mockup: `.superpowers/brainstorm/54032-1792950991/content/request-page-v2.html` (copied to `docs/superpowers/specs/request-page-v2.html` in Task 1).

## Global Constraints

- Base: `seerr-team/seerr` tag `v3.5.1`; fork `radughitescu/seerr`; work branch `custom`.
- Every new HTTP route is declared in `seerr-api.yml` (the app runs `express-openapi-validator` with `validateRequests: true` on `/api/v1`).
- Migrations are additive only, one file each under `server/migration/sqlite` and `server/migration/postgres`.
- Upstream status fields (`MediaRequest.status`, `SeasonRequest.status`, `Media.status`, `Season.status`) keep upstream semantics; pause/delete state lives only in the new table.
- Upstream rule "Only pending requests can be modified." (409 on `PUT /request/:id`) stays.
- New actions are allowed for any user who can view the request: requester, or `Permission.MANAGE_REQUESTS`, or `Permission.REQUEST_VIEW`.
- Delete always confirms in the UI and shows bytes actually freed; no other action confirms.
- Transmission is polled every 2000 ms only while ≥1 SSE client is connected; zero polling otherwise.
- New UI strings go through `react-intl` `defineMessages`; run `pnpm i18n:extract`. English only.
- Commit messages: Conventional Commits, no AI/assistant attribution of any kind.
- Image: `ghcr.io/radughitescu/seerr`, linux/amd64, tags `custom` and `custom-<shortsha>`.

## Review Focus

1. Sonarr, Radarr or Transmission unreachable or slow: the Requests page still renders upstream data, affected cards show `Status unavailable`, the SSE stream stays open, actions return a 502 with the failing service named and record no control row.
2. Torrent removed outside Seerr (Decluttarr, Transmission UI) while an item is paused: Resume falls back to re-monitor + search instead of failing.
3. Multi-episode files (`S01E01E02`) and pack files whose names carry no `SxxEyy`: file→episode mapping covers every listed episode; unmatched files fall back to whole-torrent progress; Delete preview lists every episode a file covers.
4. SSE clients disconnecting (tab closed, network drop, many tabs): listeners are removed, the poller stops when the last client leaves, no timers leak.
5. Repeated or concurrent actions (double-click Delete, two users pausing the same season): actions are idempotent; the second call returns 200 with the current state and makes no extra Sonarr/Transmission calls.

---

## File Structure

| Path | Responsibility |
|---|---|
| `.github/workflows/custom-image.yml` | Build and push the fork image |
| `server/api/transmission.ts` | Transmission RPC client |
| `server/lib/settings/index.ts` | `TransmissionSettings` in `AllSettings` |
| `server/routes/settings/transmission.ts` | GET/POST/test settings routes |
| `src/components/Settings/SettingsTransmission.tsx` | Settings form inside Services |
| `server/entity/RequestItemControl.ts` | Paused/deleted rows |
| `server/migration/{sqlite,postgres}/<ts>-AddRequestItemControl.ts` | Table migration |
| `server/lib/requestControls/store.ts` | Read/write control rows |
| `server/lib/requestControls/actions.ts` | Execute Prioritize/Pause/Resume/Delete/Restore |
| `server/lib/requestControls/preview.ts` | Delete preview (files, bytes freed) |
| `server/lib/requestControls/fileMap.ts` | Torrent file → episode mapping |
| `server/lib/liveStatus/types.ts` | Shared state/delta types (imported by the client) |
| `server/lib/liveStatus/derive.ts` | Pure state derivation |
| `server/lib/liveStatus/delta.ts` | Pure `diffSnapshots` / `applyDelta` (imported by the client) |
| `server/lib/liveStatus/sources.ts` | Fetch Sonarr/Radarr/Transmission inputs for a request |
| `server/lib/liveStatus/hub.ts` | Subscriptions, poller lifecycle, SignalR wiring |
| `server/lib/liveStatus/signalr.ts` | Sonarr/Radarr SignalR connections |
| `server/routes/requestLive.ts` | SSE stream + control/preview endpoints, mounted under `/request` |
| `server/api/servarr/sonarr.ts`, `radarr.ts`, `base.ts` | New API methods |
| `server/subscriber/MediaRequestSubscriber.ts`, `server/lib/watchlistsync.ts`, `server/routes/request.ts` | Guards |
| `src/hooks/useLiveRequests.ts` | EventSource hook |
| `src/components/RequestList/LiveCard/*.tsx` | Card UI |
| `src/components/RequestList/RequestItem/index.tsx`, `src/components/StatusBadge/index.tsx` | Integration |

---

### Task 1: Fork, branch, baseline and image pipeline

**Files:**
- Create: `.github/workflows/custom-image.yml`, `docs/superpowers/specs/2026-10-25-seerr-request-controls-design.md`, `docs/superpowers/specs/request-page-v2.html`, `docs/superpowers/plans/2026-10-25-seerr-request-controls.md`

**Interfaces:**
- Produces: repo `radughitescu/seerr`, branch `custom` from tag `v3.5.1`; image `ghcr.io/radughitescu/seerr:custom`.

- [ ] **Step 1:** `gh repo fork seerr-team/seerr --clone=false`; clone to `~/work/pers/seerr`; `git switch -c custom v3.5.1`.
- [ ] **Step 2:** `pnpm install --frozen-lockfile && pnpm test && pnpm typecheck && pnpm lint` — Expected: all pass on the untouched tag. A pre-existing upstream failure is noted in the Task 1 report and left unfixed.
- [ ] **Step 3:** Write `custom-image.yml`: trigger `push` on `custom` and `workflow_dispatch`; `permissions: packages: write, contents: read`; job 1 `test`: Node 22, pnpm, `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test`; job 2 `image` (needs `test`): `docker/setup-buildx-action`, `docker/login-action` to `ghcr.io` with `GITHUB_TOKEN`, `docker/build-push-action` with `platforms: linux/amd64`, `build-args: COMMIT_TAG=${{ github.sha }}`, tags per Global Constraints. Disable every upstream workflow on the fork with `gh workflow disable <name> -R radughitescu/seerr`.
- [ ] **Step 4:** Copy spec, mockup and this plan into `docs/superpowers/`; commit `chore: add custom image workflow and design docs`; push.
- [ ] **Step 5:** `gh run watch` — Expected: workflow green; `docker manifest inspect ghcr.io/radughitescu/seerr:custom` succeeds. Set the package visibility to public (`gh api -X PATCH /user/packages/container/seerr -f visibility=public`) so the host pulls without credentials.

### Task 2: Transmission client and settings

**Files:**
- Create: `server/api/transmission.ts`, `server/api/transmission.test.ts`, `server/routes/settings/transmission.ts`, `server/routes/settings/transmission.test.ts`, `src/components/Settings/SettingsTransmission.tsx`
- Modify: `server/lib/settings/index.ts` (`AllSettings`, defaults, getter/setter), `server/routes/settings/index.ts` (mount), `src/components/Settings/SettingsServices.tsx` (render section), `seerr-api.yml`

**Interfaces:**
- Produces:
  - `interface TransmissionSettings { enabled: boolean; hostname: string; port: number; useSsl: boolean; rpcPath: string; username: string; password: string }` — defaults `{ enabled: false, hostname: 'localhost', port: 9091, useSsl: false, rpcPath: '/transmission/rpc', username: '', password: '' }`; `getSettings().transmission`.
  - `class TransmissionAPI { constructor(s: TransmissionSettings); getTorrents(hashes: string[]): Promise<TorrentInfo[]>; start(hashes: string[]); stop(hashes: string[]); remove(hashes: string[], deleteLocalData: boolean); setFilesWanted(hash: string, fileIndexes: number[], wanted: boolean); setFilePriorityHigh(hash: string, fileIndexes: number[]); queueMoveTop(hashes: string[]); setBandwidthPriorityHigh(hashes: string[]); test(): Promise<{ version: string }> }`
  - `interface TorrentInfo { hashString: string; name: string; status: 0|1|2|3|4|5|6; percentDone: number; rateDownload: number; eta: number; peersSendingToUs: number; peersConnected: number; sizeWhenDone: number; error: number; errorString: string; files: { index: number; name: string; length: number; bytesCompleted: number }[]; fileStats: { wanted: boolean; priority: -1|0|1 }[] }`
  - Routes: `GET /api/v1/settings/transmission`, `POST /api/v1/settings/transmission`, `POST /api/v1/settings/transmission/test` (admin, under existing `/settings` mount). Password never returned by GET (empty string when set, plus `hasPassword: boolean`).

- [ ] **Step 1: Failing tests** in `transmission.test.ts` (mock the client's axios instance as `sonarr.test.ts` does):
  - `retries once with X-Transmission-Session-Id after a 409` — first POST rejects with status 409 and header `x-transmission-session-id: abc`; second call is sent with header `X-Transmission-Session-Id: abc`; resolves.
  - `getTorrents sends torrent-get with lowercase hashes and the TorrentInfo fields` — asserts `method: 'torrent-get'`, `arguments.ids` equals input lowercased, `arguments.fields` includes `files` and `fileStats`.
  - `setFilesWanted(false) sends torrent-set files-unwanted`.
  - `remove(hashes, true) sends torrent-remove with delete-local-data true`.
- [ ] **Step 2:** `pnpm test server/api/transmission.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3:** Implement `TransmissionAPI` with axios, basic auth, URL `http(s)://hostname:port{rpcPath}`; session-id cached on the instance.
- [ ] **Step 4:** Failing route tests in `server/routes/settings/transmission.test.ts`: `GET hides password and reports hasPassword`, `POST keeps existing password when body password is empty`, `non-admin gets 403`.
- [ ] **Step 5:** Implement settings type/defaults, routes, `seerr-api.yml` entries; `SettingsTransmission.tsx` form (fields as above + Test button calling `/test`, toast on result) rendered at the bottom of `SettingsServices.tsx`.
- [ ] **Step 6:** `pnpm test server/api/transmission.test.ts server/routes/settings/transmission.test.ts && pnpm typecheck && pnpm lint` — Expected: PASS.
- [ ] **Step 7:** Commit `feat: transmission connection settings and rpc client`.

### Task 3: Control rows (entity, migrations, store)

**Files:**
- Create: `server/entity/RequestItemControl.ts`, `server/migration/sqlite/<ts>-AddRequestItemControl.ts`, `server/migration/postgres/<ts>-AddRequestItemControl.ts`, `server/lib/requestControls/store.ts`, `server/lib/requestControls/store.test.ts`
- Modify: `server/entity/MediaRequest.ts` (`@OneToMany controls`)

**Interfaces:**
- Produces:
  - `type ControlState = 'paused' | 'deleted'`
  - Entity `RequestItemControl { id; request: MediaRequest (ManyToOne, onDelete CASCADE, indexed); seasonNumber: number | null; episodeNumber: number | null; state: ControlState; pausedAtPercent: number | null; createdBy: User | null (onDelete SET NULL); createdAt; updatedAt }`, unique index on `(requestId, seasonNumber, episodeNumber)`. `seasonNumber=null` = whole request (movie or all seasons); `episodeNumber=null` = whole season.
  - `type ItemKey = { requestId: number; seasonNumber: number | null; episodeNumber: number | null }`
  - `store.getControls(requestId: number): Promise<RequestItemControl[]>`
  - `store.setControl(key: ItemKey, state: ControlState, userId: number, pausedAtPercent?: number): Promise<RequestItemControl>` — upsert; setting a season clears its episode rows; setting the whole request clears all child rows.
  - `store.clearControl(key: ItemKey): Promise<void>` — clears the key and its children.
  - `store.effectiveState(controls: RequestItemControl[], seasonNumber: number | null, episodeNumber: number | null): ControlState | null` — nearest of episode → season → request.
  - `store.isBlocked(mediaId: number, seasonNumber?: number, episodeNumber?: number): Promise<boolean>` — true when any request on that media has an effective paused/deleted state for the item.

- [ ] **Step 1: Failing tests** (`setupTestDb` from `server/test/db.ts`):
  - `setControl on a season removes episode rows of that season`
  - `effectiveState prefers episode over season over request` — rows `{s:1,e:null,paused}`, `{s:1,e:4,deleted}` → `(1,4)='deleted'`, `(1,5)='paused'`, `(2,1)=null`.
  - `clearControl on request clears every row`
  - `isBlocked is true for an episode under a deleted season`
  - `rows are removed when the request is deleted` (cascade)
- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3:** Implement entity; generate migrations with `pnpm migration:generate` against SQLite, hand-write the Postgres equivalent following the latest postgres migration's style; implement store.
- [ ] **Step 4:** `pnpm test server/lib/requestControls/store.test.ts && pnpm typecheck` — Expected: PASS. Also start the app once against a copy of a v3.5.1 DB to confirm the migration runs.
- [ ] **Step 5:** Commit `feat: request item control table`.

### Task 4: Sonarr and Radarr API additions

**Files:**
- Modify: `server/api/servarr/base.ts`, `server/api/servarr/sonarr.ts`, `server/api/servarr/radarr.ts`, `server/api/servarr/sonarr.test.ts`, `server/api/servarr/radarr.test.ts`

**Interfaces:**
- Produces (base): `getQueueFor(params: { seriesId?: number; movieId?: number }): Promise<QueueRecord[]>` (`includeEpisode: true`, `pageSize: 1000`); `removeQueueItems(ids: number[], removeFromClient: boolean): Promise<void>` (`DELETE /queue/bulk`, `blocklist=false`, `skipRedownload=true`); `getCommands(): Promise<CommandResource[]>`.
- Produces (sonarr): `setEpisodesMonitored(episodeIds: number[], monitored: boolean)` (`PUT /episode/monitor`; `monitorEpisodes(ids)` becomes a wrapper with `true`); `setSeasonMonitored(seriesId: number, seasonNumber: number, monitored: boolean)` (GET series, flip season, PUT series); `searchEpisodes(episodeIds: number[])` (`EpisodeSearch`); `searchSeason(seriesId: number, seasonNumber: number)` (`SeasonSearch`); `getEpisodeFiles(seriesId: number): Promise<EpisodeFile[]>`; `deleteEpisodeFiles(ids: number[])` (`DELETE /episodefile/bulk`). `EpisodeResult` gains `lastSearchTime?: string`.
- Produces (radarr): `setMovieMonitored(movieId: number, monitored: boolean)`; `getMovieFiles(movieId: number)`; `deleteMovieFile(id: number)`. `RadarrMovie` gains `lastSearchTime?: string`.
- `QueueRecord` includes `id, downloadId, episodeId?, movieId?, seasonNumber?, trackedDownloadState, trackedDownloadStatus, statusMessages, errorMessage, size, sizeleft`.

- [ ] **Step 1: Failing tests** — one per method asserting HTTP verb, path and body, e.g. `setEpisodesMonitored(false) PUTs /episode/monitor with monitored false`, `removeQueueItems DELETEs /queue/bulk with removeFromClient, blocklist=false, skipRedownload=true`, `setSeasonMonitored flips only the given season`.
- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm test server/api/servarr && pnpm typecheck` — Expected: PASS.
- [ ] **Step 5:** Commit `feat: servarr monitor, search, queue and file methods`.

### Task 5: Live state types, derivation and diffing

**Files:**
- Create: `server/lib/liveStatus/types.ts`, `server/lib/liveStatus/derive.ts`, `server/lib/liveStatus/derive.test.ts`, `server/lib/liveStatus/delta.ts`, `server/lib/liveStatus/delta.test.ts`, `server/lib/requestControls/fileMap.ts`, `server/lib/requestControls/fileMap.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  - `type ItemStatus = 'searching' | 'not_found' | 'queued' | 'downloading' | 'stalled' | 'paused' | 'importing' | 'on_plex' | 'deleted' | 'failed' | 'unknown'`
  - `interface ItemState { seasonNumber: number | null; episodeNumber: number | null; title?: string; status: ItemStatus; percent?: number; bytesOnDisk?: number; etaSeconds?: number; lastSearchedAt?: string; error?: string; actions: ItemAction[] }`
  - `type ItemAction = 'prioritize' | 'pause' | 'resume' | 'delete' | 'restore'`
  - `interface SeasonState { seasonNumber: number; status: ItemStatus; release?: { name: string; sizeBytes: number; peers: number; rateBytes: number }; episodes: ItemState[]; actions: ItemAction[] }`
  - `interface RequestLiveState { requestId: number; available: boolean; summary: { status: ItemStatus; percent?: number; ready: number; total: number; paused: number; deleted: number; etaSeconds?: number }; seasons: SeasonState[]; movie?: ItemState; actions: ItemAction[]; updatedAt: string }` — `available=false` means a source failed (UI shows `Status unavailable`).
  - `type LiveDelta = { requestId: number; path: (string | number)[]; value: unknown }`
- Produces (`derive.ts`): `deriveItemStatus(input: ItemInputs): ItemStatus` and `deriveRequestState(input: RequestInputs): RequestLiveState`, where `RequestInputs = { requestId: number; type: 'movie' | 'tv'; controls: RequestItemControl[]; episodes: { seasonNumber: number; episodeNumber: number; title: string; monitored: boolean; hasFile: boolean; episodeFileId?: number; sizeOnDisk?: number; lastSearchTime?: string }[]; movie?: { monitored: boolean; hasFile: boolean; sizeOnDisk?: number; lastSearchTime?: string }; queue: QueueRecord[]; torrents: TorrentInfo[]; runningSearches: { episodeIds?: number[]; seriesId?: number; seasonNumber?: number; movieIds?: number[] }[]; requestedSeasons: number[]; failedSources: ('sonarr' | 'radarr' | 'transmission')[] }` and `ItemInputs = { control: ControlState | null; hasFile: boolean; queue?: QueueRecord; torrent?: TorrentInfo; fileIndexes?: number[]; searchRunning: boolean; lastSearchTime?: string; monitored: boolean }`.
- Produces (`delta.ts`): `diffSnapshots(prev: RequestLiveState | undefined, next: RequestLiveState): LiveDelta[]` (leaf-level paths; a whole new state yields one delta with `path: []`); `applyDelta(state: RequestLiveState, d: LiveDelta): RequestLiveState` (immutable).
- Produces (`fileMap.ts`): `mapFilesToEpisodes(files: TorrentInfo['files']): Map<string, number[]>` keyed `"<season>x<episode>"` → file indexes, regex `/S(\d{1,2})((?:[ ._-]?E\d{1,3})+)/i`; files with no match are absent.

Derivation precedence (first match wins): `control=deleted → deleted`; `control=paused → paused`; `hasFile → on_plex`; queue `trackedDownloadStatus='error'` or torrent `error>0` → `failed`; queue `trackedDownloadState in ('importPending','importing')` → `importing`; torrent present: status 3, or status 4 with this item's files at 0 bytes → `queued`; status 4 with `rateDownload=0 && peersSendingToUs=0` → `stalled`; status 4 → `downloading`; `searchRunning` → `searching`; `monitored && lastSearchTime` → `not_found`; else `unknown`. Percent for an episode = sum(bytesCompleted)/sum(length) over its mapped files, else torrent `percentDone`. Season/summary status = most active among children in order `downloading, importing, searching, queued, stalled, failed, not_found, paused, on_plex, deleted, unknown`. Actions: `on_plex → [delete]`; `paused → [resume, delete]`; `deleted → [restore]`; otherwise `[prioritize, pause, delete]`.

- [ ] **Step 1: Failing tests** (`derive.test.ts`): one per precedence row above, plus `season status is downloading when one episode downloads and others are on_plex`, `summary counts ready/paused/deleted`, `episode percent uses its mapped files`, `episode without mapped files uses torrent percentDone`. (`fileMap.test.ts`): `maps S01E04 to [index]`, `maps S01E01E02 to both episodes`, `maps "s1.e05" style`, `ignores sample/ nfo files without SxxEyy`. (`delta.test.ts`): `no deltas for equal states`, `single episode percent change yields one leaf delta`, `applyDelta(diff(a,b)) equals b` over three fixture pairs.
- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm test server/lib/liveStatus server/lib/requestControls/fileMap.test.ts` — Expected: PASS.
- [ ] **Step 5:** Commit `feat: live request state derivation and diffing`.

### Task 6: Sources and hub (SignalR, Transmission poller, subscriptions)

**Files:**
- Create: `server/lib/liveStatus/sources.ts`, `server/lib/liveStatus/signalr.ts`, `server/lib/liveStatus/hub.ts`, `server/lib/liveStatus/hub.test.ts`
- Modify: `package.json` (add `@microsoft/signalr`), `server/index.ts` (start hub after settings load)

**Interfaces:**
- Consumes: Task 2 `TransmissionAPI`, Task 3 `store.getControls`, Task 4 API methods, Task 5 `deriveRequestState`, `diffSnapshots`.
- Produces:
  - `loadRequestInputs(request: MediaRequest): Promise<RequestInputs>` (`sources.ts`) — one Sonarr/Radarr round per request: series episodes, episode files, queue for series/movie, running commands; Transmission `getTorrents` for queue `downloadId`s.
  - `class LiveStatusHub { subscribe(requestIds: number[], listener: (e: { type: 'snapshot'; state: RequestLiveState } | { type: 'delta'; deltas: LiveDelta[] }) => void): () => void; refresh(requestId: number): Promise<void>; refreshByService(kind: 'sonarr' | 'radarr', externalId: number): Promise<void>; clientCount(): number }`; singleton `liveStatusHub`.
  - On subscribe: send a snapshot per id immediately; first subscriber starts a 2000 ms `setInterval` that refreshes every subscribed request; last unsubscribe clears it.
  - `startServarrSignalR(onEvent: (kind: 'sonarr'|'radarr', serverId: number, msg: { name: string; body: unknown }) => void): () => void` — one `HubConnectionBuilder` per configured server at `<url>/signalr/messages?access_token=<apiKey>`, `withAutomaticReconnect()`; events named `queue`, `command`, `episode`, `episodefile`, `movie`, `moviefile` trigger `refreshByService` for subscribed requests matching the series/movie id; other events ignored.
  - A source error marks that request `available=false` and is logged with label `LiveStatus`; it never throws out of the interval.

- [ ] **Step 1: Failing tests** (`hub.test.ts`, stub `loadRequestInputs` via `mock.method`, use `server/test/runWithMockTimers.ts`):
  - `first subscriber receives a snapshot synchronously after load`
  - `poller ticks every 2000 ms while subscribed and stops after the last unsubscribe` — advance 6000 ms → 3 refreshes; unsubscribe; advance 6000 ms → still 3.
  - `two subscribers share one poller`
  - `unchanged state emits no delta`
  - `source rejection emits available=false and keeps polling`
- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3:** Implement sources, hub, SignalR wiring; start in `server/index.ts` after `getSettings().load()`, restart connections when Sonarr/Radarr settings change (subscribe to the existing settings save path).
- [ ] **Step 4:** `pnpm test server/lib/liveStatus && pnpm typecheck && pnpm lint` — Expected: PASS.
- [ ] **Step 5:** Commit `feat: live status hub with servarr signalr and transmission polling`.

### Task 7: Actions, delete preview and HTTP endpoints

**Files:**
- Create: `server/lib/requestControls/actions.ts`, `server/lib/requestControls/actions.test.ts`, `server/lib/requestControls/preview.ts`, `server/routes/requestLive.ts`, `server/routes/requestLive.test.ts`
- Modify: `server/routes/request.ts` (mount `requestLive` before `/:requestId` routes), `seerr-api.yml`

**Interfaces:**
- Consumes: Tasks 2–6.
- Produces:
  - `runAction(req: { request: MediaRequest; action: ItemAction; seasonNumber: number | null; episodeNumber: number | null; user: User }): Promise<RequestLiveState>` — validates the action against the item's current `actions`; if the item is already in the target state returns current state without external calls; on any external failure throws `ServiceError { service: 'sonarr'|'radarr'|'transmission'; message }` and writes no control row; calls `liveStatusHub.refresh(requestId)` on success.
  - Effects (exactly the spec "Actions" table):
    - `prioritize`: no torrent → `searchEpisodes`/`searchSeason`/`searchMovie`; torrent → `queueMoveTop` + `setBandwidthPriorityHigh`; pack + episode → `setFilePriorityHigh(fileIndexes)`.
    - `pause`: unmonitor (episode/season/movie); torrent wholly covered by the item → `stop`; else `setFilesWanted(false)`; `setControl(paused, pausedAtPercent)`.
    - `resume`: re-monitor; torrent still present → `start` / `setFilesWanted(true)`; torrent gone → search; `clearControl`.
    - `delete`: unmonitor; torrent wholly covered → `removeQueueItems(ids, removeFromClient=true)` (fallback `transmission.remove(hash, true)` when no queue record); else `setFilesWanted(false)`; delete imported files (`deleteEpisodeFiles` / `deleteMovieFile`); `setControl(deleted)`.
    - `restore`: re-monitor, search, `clearControl`.
  - `getDeletePreview(request, seasonNumber, episodeNumber): Promise<{ files: { path: string; bytes: number; episodes: string[] }[]; bytesFreed: number; torrentKept: boolean }>` — `bytesFreed` counts library files plus torrent data only when the torrent is removed; a library file hardlinked to a kept torrent file counts 0 and sets `torrentKept=true`.
  - Routes (all `isAuthenticated()`, visibility = requester or `MANAGE_REQUESTS` or `REQUEST_VIEW`, else 403):
    - `GET /api/v1/request/live?ids=1,2,3` → `text/event-stream`; events `snapshot` (data `RequestLiveState`) and `delta` (data `LiveDelta[]`); `: ping` comment every 15000 ms; headers `Cache-Control: no-cache`, `X-Accel-Buffering: no`; on `close` unsubscribe. Ids the user cannot view are silently dropped. Max 50 ids.
    - `POST /api/v1/request/{requestId}/control` body `{ action: ItemAction; seasonNumber?: number; episodeNumber?: number }` → 200 `RequestLiveState`; 400 invalid action for current state; 502 `{ service, message }` on `ServiceError`.
    - `GET /api/v1/request/{requestId}/control/delete-preview?seasonNumber=&episodeNumber=` → preview JSON.

- [ ] **Step 1: Failing tests** (`actions.test.ts`, mock API prototypes):
  - one per effect bullet above asserting the exact external calls;
  - `pause on an already paused item makes no external calls`;
  - `transmission failure during pause throws ServiceError and leaves no control row`;
  - `resume falls back to search when the torrent no longer exists`;
  - `delete of S01E01 whose file is S01E01E02 deletes the file and reports both episodes in preview`;
  - `preview reports bytesFreed 0 and torrentKept true for a pack episode still seeding`.
- [ ] **Step 2:** Failing route tests (`requestLive.test.ts`, supertest + session like `request.test.ts`): `requester can POST control`, `REQUEST_VIEW user can POST control on another user's request`, `user without view rights gets 403`, `SSE sends snapshot then delta and unsubscribes on close` (read the stream with `request(app).get(...).buffer(false).parse(...)`; abort; assert `liveStatusHub.clientCount()===0`), `ServiceError maps to 502 with service name`.
- [ ] **Step 3:** Run — Expected: FAIL.
- [ ] **Step 4:** Implement actions, preview, routes, OpenAPI entries.
- [ ] **Step 5:** `pnpm test server/lib/requestControls server/routes/requestLive.test.ts && pnpm typecheck && pnpm lint` — Expected: PASS.
- [ ] **Step 6:** Commit `feat: request control actions and live status endpoints`.

### Task 8: Guards so paused/deleted items never return on their own

**Files:**
- Modify: `server/subscriber/MediaRequestSubscriber.ts` (`sendToSonarr`, `sendToRadarr`), `server/lib/watchlistsync.ts`, `server/routes/request.ts` (`POST /request`)
- Test: `server/subscriber/MediaRequestSubscriber.test.ts` (create), `server/lib/watchlistsync.test.ts`, `server/routes/request.test.ts`

**Interfaces:**
- Consumes: Task 3 `store.getControls`, `store.effectiveState`, `store.isBlocked`; Task 7 `runAction`.

Behaviour:
- `sendToSonarr`: seasons whose effective state is paused/deleted are removed from the season list sent; after the add/update, episodes with an episode-level paused/deleted row are unmonitored via `setEpisodesMonitored(ids,false)`; when every requested season is blocked, no Sonarr call is made and no search is triggered.
- `sendToRadarr`: a request whose movie row is paused/deleted makes no Radarr call.
- `watchlistsync`: skips items where `store.isBlocked(mediaId)` (movie) or every season is blocked (TV).
- `POST /request` for a media that has an existing request with paused/deleted state covering the requested seasons: for each covered item run `runAction(resume|restore)` on the existing request and return 201 with the existing request (no new row). Seasons not covered follow upstream behaviour.

- [ ] **Step 1: Failing tests:** `sendToSonarr omits a deleted season and triggers no search when all seasons are blocked`; `sendToSonarr unmonitors an episode-level paused row after update`; `sendToRadarr skips a paused movie`; `watchlist sync does not request a deleted movie`; `POST /request on a deleted season restores the existing request instead of creating a new one` (assert request count unchanged and `runAction` called with `restore`).
- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm test && pnpm typecheck && pnpm lint` (full suite; upstream tests must stay green) — Expected: PASS.
- [ ] **Step 5:** Commit `feat: keep paused and deleted items from being re-sent or re-requested`.

### Task 9: Requests page live card

**Files:**
- Create: `src/hooks/useLiveRequests.ts`, `src/components/RequestList/LiveCard/index.tsx`, `src/components/RequestList/LiveCard/SeasonSection.tsx`, `src/components/RequestList/LiveCard/EpisodeRow.tsx`, `src/components/RequestList/LiveCard/ControlButton.tsx`, `src/components/RequestList/LiveCard/DeleteConfirmModal.tsx`
- Modify: `src/components/RequestList/RequestItem/index.tsx`, `src/components/RequestList/index.tsx`, `src/components/StatusBadge/index.tsx`, `src/i18n/locale/en.json` (via extract)

**Interfaces:**
- Consumes: Task 5 `types.ts` and `applyDelta` (import from `@server/lib/liveStatus/*`; both are dependency-free), Task 7 endpoints.
- Produces:
  - `useLiveRequests(ids: number[]): { states: Record<number, RequestLiveState>; connected: boolean }` — one `EventSource('/api/v1/request/live?ids=…', { withCredentials: true })` per page; reopens when `ids` change; on `snapshot` replaces, on `delta` applies; `EventSource` auto-reconnect handles drops and the server resends snapshots.
  - `<LiveCard request={MediaRequest} state={RequestLiveState | undefined} onAction={(a, s, e) => Promise<void>} />`.
  - `StatusBadge` gains `disableLink?: boolean`; RequestItem passes `true`.

Rendering (mockup A v2): header status line `"{status label} {percent}% · {ready}/{total} ready · {paused} paused · ETA {eta}"` (omit zero/absent parts); progress bar; card buttons `▶ Play on Plex` (only when `media.mediaUrl` exists; uses `useDeepLinks` like upstream; opens in new tab), `⏸ Pause all`/`▶ Resume all`, `🗑 Delete request`; seasons collapsible (first non-deleted season open); episode rows with badge colours per status (`on_plex` green, `downloading` indigo with mini bar, `paused` amber with mini bar, `searching` yellow, `not_found`/`failed`/`stalled` red, `queued` gray, `deleted` dim red); consecutive episodes with equal status and no percent collapse into `E06–10 · 5 episodes` rows that expand on click; only buttons listed in `actions` render. `available=false` → `Status unavailable` badge and upstream badge kept. Buttons disable while their request is in flight; errors show a toast with the service name from the 502 body. Delete opens `DeleteConfirmModal` which loads `delete-preview` and shows file count, episodes and `bytesFreed` (with the "torrent copy kept while seeding" note when `torrentKept`).
- Integration: LiveCard renders for `status === APPROVED || status === COMPLETED` requests; pending/declined/failed keep upstream markup and buttons. Upstream admin row delete label becomes "Remove from list"; upstream Approve/Decline/Edit/Retry/"Remove from *arr" stay.

- [ ] **Step 1:** Implement hook and components; extract messages (`pnpm i18n:extract`).
- [ ] **Step 2:** `pnpm typecheck && pnpm lint && pnpm build` — Expected: PASS.
- [ ] **Step 3:** Run locally (`pnpm dev`) against the asus Sonarr/Radarr/Transmission (read-only browsing: no actions) and compare against `docs/superpowers/specs/request-page-v2.html`; screenshot desktop and 390 px width.
- [ ] **Step 4:** Commit `feat: live request card with season and episode controls`.

### Task 10: Deploy to asus and verify end to end

**Files:**
- Modify on `asus`: `/opt/seerr/compose.yaml` (image line only)

- [ ] **Step 1:** Push `custom`; `gh run watch` — Expected: image `custom-<sha>` published.
- [ ] **Step 2:** On asus: `docker compose -f /opt/seerr/compose.yaml stop seerr`; copy `/srv/apps/seerr/db/db.sqlite3*` and `settings.json` to `/root/seerr-pre-fork-<date>/`; set `image: ghcr.io/radughitescu/seerr:custom`; `docker compose up -d`; `docker logs seerr` shows migrations ran and `Server ready on port 5055`.
- [ ] **Step 3:** In Seerr: Settings → Services → Transmission: `localhost`, `9091`, `/transmission/rpc`, credentials from `/etc/transmission-daemon/settings.json`; Test → OK. Users → demetraneacsu → add `View Requests`.
- [ ] **Step 4:** Verify with the live The Terror S1 request (or a fresh small request): episode rows update without reload while downloading; Prioritize moves the torrent to queue top (`transmission-remote -l` order); Pause one pack episode → file unwanted, Sonarr episode unmonitored, row `Paused at N%`; Resume restores; Delete preview shows correct bytes; Restore triggers a search; nothing re-grabs a deleted item after 30 min (check Sonarr history). Close all tabs → `ss -tnp | rg 9091` shows no polling connections from Seerr after 10 s.
- [ ] **Step 5:** Confirm Watchtower picks up `ghcr.io/radughitescu/seerr:custom` (next 04:30 run log).
- [ ] **Step 6:** Rollback recipe (documented in the fork README section "Custom build"): set image back to `ghcr.io/seerr-team/seerr:latest`, restore DB copy.
