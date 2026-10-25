# Seerr fork: live request status and per-season/episode controls

Date: 2026-10-25
Base: `seerr-team/seerr` tag `v3.5.1` (MIT)
Fork: `radughitescu/seerr`
Target host: `asus` (192.168.1.139), Debian 13, Seerr in Docker with host networking on port 5055

## Intent

The Requests page is the single place where any household member sees exactly where each request stands (searching, found, downloading, importing, on Plex) down to the episode, and controls it: prioritize, pause/resume, delete/restore, per request, per season and per episode. Playing on Plex is an explicit button, separate from status.

Users: two Plex-linked accounts, `radughitescu742` (admin) and `demetraneacsu` (Request + Auto-Approve). Requests are normally auto-approved, so controls must work on approved requests.

## Goals

1. Live, granular status on the Requests page, pushed to the browser (no client polling).
2. Per request / season / episode actions: Prioritize, Pause, Resume, Delete, Restore.
3. A dedicated "Play on Plex" button per card. Status badges do not link to Plex.
4. Paused and deleted items stay visible on the card with their state and the action that reverses it.

## Non-goals

- Changes to the title detail page, the "Manage series" slide-over, Discover, or search.
- Requesting individual episodes from the request modal.
- Support for download clients other than Transmission, or for Jellyfin/Emby.
- Postgres support beyond keeping migrations runnable (deployment uses SQLite).

## Anti-goals (failure even if it works)

- A paused or deleted season/episode starts downloading again without a user clicking Resume/Restore. Sources to guard: Sonarr/Radarr monitored flags and searches, `MediaRequestSubscriber` re-sending a request to Sonarr/Radarr on entity update, Seerr scheduled sync jobs, and auto-request (watchlist) flows.
- Upstream Seerr behaviour outside the Requests page changes.
- Data loss without a confirmation dialog.

## Layout (chosen: mockup "A v2")

Mockups: `/Users/radughitescu/work/pers/dietpi/.superpowers/brainstorm/54032-1792950991/content/request-page-v2.html`.

Each request is an expandable card:

- Header: poster, title, year, requester, request time, approval mode.
- Overall status line, e.g. `Downloading 41% · 3/10 ready · 1 paused · ETA 22 min`, with a progress bar.
- Card buttons: `▶ Play on Plex` (shown when anything is on Plex; opens the media in Plex), `⏸ Pause all` / `▶ Resume all`, `🗑 Delete request`.
- TV: one collapsible section per requested season. Season header shows release name, quality, size, peers, speed and season-level buttons (⇡ Prioritize, ⏸ Pause / ▶ Resume, 🗑 Delete / ↻ Restore).
- Under each season, one row per episode: number, title, state badge (with progress bar while downloading) and episode-level buttons.
- Consecutive episodes with identical state may collapse into one row (`E06–10 · 5 episodes · Queued in pack`) that expands on click.
- Movies: same card, no season sections; actions apply to the single item.
- Deleted seasons render collapsed and dimmed with `🗑 Deleted · <date>` and `↻ Restore`.
- Existing Requests page sorting and filters remain.

### States shown per episode / movie

| State | Meaning |
|---|---|
| Searching | A Sonarr/Radarr search command covering the item is running |
| No release found | Last search finished without a grab; shows when it was last searched |
| Queued | Grabbed, waiting in Transmission queue or not yet started inside a pack |
| Downloading N% | Transmission is transferring this file; per-file percent, speed, ETA |
| Stalled | Torrent active with 0 peers / no progress |
| Paused at N% | Paused by a user |
| Importing | Download complete, Sonarr/Radarr import pending or running |
| On Plex | File present in the Plex library |
| Deleted | Deleted by a user, restorable |
| Failed | Import failed or download error, with the error text from Sonarr/Radarr/Transmission |

The overall card state is derived from its items (most active state wins; counts of ready/paused/deleted shown).

## Actions

All logged-in users may use every action on every request. Delete always opens a confirmation dialog that names what is deleted and the size on disk. No other action asks for confirmation.

| Action | Scope | Effect |
|---|---|---|
| Prioritize ⇡ | request, season, episode, movie | Not yet grabbed: run search now. Grabbed: move torrent to top of Transmission queue and set high bandwidth priority; inside a pack, set the episode's file priority high. |
| Pause ⏸ | request, season, episode, movie (only items not yet on Plex) | Unmonitor in Sonarr/Radarr. Whole torrent covered: stop torrent. Part of a pack: mark the episode's files unwanted. Partial data is kept. Files already on Plex are untouched. |
| Resume ▶ | paused items | Re-monitor. Restart torrent / mark files wanted. If nothing was grabbed yet, run a search. |
| Delete 🗑 | request, season, episode, movie | Unmonitor; remove the torrent with its data when the whole torrent is covered, otherwise mark the files unwanted; delete imported files through Sonarr/Radarr (episode file / movie file delete); mark the item deleted in Seerr. |
| Restore ↻ | deleted items | Re-monitor and search; item re-enters the normal state flow and downloads again. |

"Delete request" deletes every item in the request and then keeps the card visible as deleted with Restore. Removing a card from the list entirely is upstream's existing request-row delete, relabelled "Remove from list", with upstream's permission rules unchanged.

### Upstream card actions and non-approved requests (designer's call)

- Pending requests keep upstream's Approve / Decline / Edit; declined requests render as upstream. The new status sections and controls appear once a request is approved.
- Failed requests keep upstream's Retry.
- Upstream "Remove from *arr" stays where it is today.

### Requesting a paused or deleted item again (designer's call)

- An explicit request made elsewhere in Seerr (title page, request modal) for a paused or deleted item counts as Resume / Restore on the existing request: the paused/deleted marker is cleared and no second request is created.
- Watchlist auto-request and Seerr sync jobs never create a request or trigger a search for an item that is paused or deleted.
- Pause/delete state lives only in new columns/entities. Upstream status fields (`MediaRequest.status`, `SeasonRequest.status`, `Media.status`, `Season.status`) keep upstream semantics, so Discover and title-page badges follow upstream logic (e.g. `availabilitySync` marking deleted media `DELETED`).
- Existing Requests-page filters keep upstream behaviour; a paused/deleted card appears under whatever filter its upstream status matches.

Season-pack edge: deleting one episode of a pack whose torrent is still seeding removes the library copy; the torrent's copy of that file remains until the whole torrent is deleted (Transmission cannot delete a single file). The confirmation dialog states the space actually freed.

## Live updates

- Browser ↔ Seerr: one Server-Sent Events stream (`text/event-stream`) per open Requests page, authenticated with the existing Seerr session cookie. On connect the server sends a full snapshot for the requests on the page, then deltas (per item state/progress changes). The client reconnects automatically and re-receives a snapshot.
- Sonarr/Radarr → Seerr: subscribe to their SignalR hub (`/signalr/messages`, API key) for queue, command, episode/movie and episode-file events. Configured Sonarr/Radarr webhooks ("Connect" → Webhook to a Seerr endpoint) are an accepted fallback if SignalR proves unreliable.
- Transmission → Seerr: RPC poll every 2 s, only while at least one SSE client is connected; no polling when no one watches.
- Seerr diffs successive snapshots and emits only changes.

## Seerr configuration additions

- Settings → Services: a Transmission connection (host, port, RPC path, username, password, SSL) with a test button. Transmission on `asus` requires RPC auth.
- No new user permission: the new actions are available to any user who can view the request.
- `demetraneacsu` is granted `REQUEST_VIEW` in Seerr user settings so she sees every user's requests (upstream list filtering stays as is).

## External settings on `asus` (current values, relied on)

- Transmission: `download-queue-enabled: true`, `download-queue-size: 3`, RPC auth required, no ratio or idle seeding limits.
- Sonarr download client: `removeCompletedDownloads: false`, so partial pack data of paused episodes survives until the user deletes it.
- Radarr download client: `removeCompletedDownloads: true`; movie torrents disappear after import, so movie Delete after import is a movie-file delete only.
- The plan may change these settings on `asus` if a feature requires it; any change is listed in the plan.

## Persistence

Paused/deleted state per request item (season, episode, movie) is stored in Seerr's DB through new TypeORM entities/columns plus SQLite and Postgres migrations. Migrations are additive only, so the upstream image can still start against the DB after rollback.

## Delivery and operations

- Work on a branch of the fork (e.g. `custom`), rebased/merged onto upstream release tags by hand.
- GitHub Actions in the fork builds a linux/amd64 image to `ghcr.io/radughitescu/seerr` on pushes to that branch.
- `/opt/seerr/compose.yaml` on `asus` switches its image to `ghcr.io/radughitescu/seerr:<tag>`. Watchtower keeps updating it from that image.
- Before first deploy: stop container, back up `/srv/apps/seerr/db/db.sqlite3` (and `settings.json`). Rollback = upstream image + restored DB.

## Existing code touchpoints (v3.5.1)

- `server/lib/downloadtracker.ts`: current Sonarr/Radarr queue tracker; extend or replace with the live state service.
- `server/api/servarr/sonarr.ts`, `server/api/servarr/radarr.ts`: API clients to extend (monitor, search, queue, episode file delete, SignalR).
- `server/routes/request.ts`: request routes; new action and SSE endpoints live here or in a sibling router registered in `server/routes/index.ts`. Upstream blocks modifying non-pending requests (409 "Only pending requests can be modified.") and that rule stays for its existing endpoint.
- `server/subscriber/MediaRequestSubscriber.ts`: must not re-send paused/deleted items to Sonarr/Radarr.
- `server/entity/MediaRequest.ts`, `server/entity/SeasonRequest.ts`, `server/entity/Season.ts`, `server/entity/Media.ts`; migrations under `server/migration/sqlite` and `server/migration/postgres`.
- `src/components/RequestList/RequestItem/index.tsx`, `src/components/RequestList/index.tsx`, `src/components/StatusBadge/index.tsx` (badge links to Plex via `plexUrl`; on the Requests page it must not link).
- `server/lib/settings/index.ts`: settings schema for the Transmission connection.

## Delete dialog

Shows the space actually freed. Marking a file unwanted in Transmission frees nothing, so a mid-download pack episode reports only its imported library copy, if any.

## Left to the builder

- Internal module structure, event names and payload shapes.
- Whether "On Plex" per episode comes from Plex library data or Sonarr `hasFile` plus Seerr's Plex availability.
- Exact collapse rules for episode rows and the visual polish, staying close to the mockup and Seerr's existing Tailwind styling.
- i18n: new strings go through Seerr's existing `react-intl` message system (English only required).
- Test strategy, following the repo's existing test setup.
