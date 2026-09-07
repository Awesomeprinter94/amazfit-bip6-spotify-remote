<div align="center">
  <img src="assets/gt.s/icon.png" width="112" alt="Spotify Control app icon">

  # Spotify Remote for Amazfit Bip 6

  **Control Spotify from your wrist—with playlists, search, liked songs, artwork, queue access, and phone volume.**

  [![Zepp OS](https://img.shields.io/badge/Zepp_OS-4.0-111111?style=flat-square)](https://docs.zepp.com/)
  [![Device](https://img.shields.io/badge/Amazfit-Bip_6-1ED760?style=flat-square)](#compatibility)
  [![Version](https://img.shields.io/badge/version-1.6.0-1ED760?style=flat-square)](package.json)
  [![License](https://img.shields.io/badge/license-ISC-555555?style=flat-square)](package.json)
</div>

## Overview

Spotify Remote is a Zepp OS mini app made for the Amazfit Bip 6. It connects to Spotify through the phone-side Zepp service and presents a compact, scrollable interface designed for the watch display.

> This is an independent project and is not affiliated with, sponsored by, or endorsed by Spotify or Amazfit.

## Features

| Area | What you can do |
| --- | --- |
| Now playing | View the current song, artist, progress, and quickly preloaded album artwork |
| Playback | Play/pause and move to the previous or next track |
| Liking | Like or unlike the current song directly from the Now Playing screen |
| Album art | Tap the current cover to open it fullscreen |
| Playlists | Automatically load every playlist page returned by Spotify, search locally, and filter by **All**, **Mine**, or **Spotify** |
| Liked Songs | Browse saved tracks in pages of 30, with covers for every song that has artwork |
| Search | Search Spotify by song, artist, or album and play a result |
| Radio | Start a song recommendation set, or choose an artist mix when recommendations are unavailable |
| Queue | View the current queue, search for tracks, and add tracks or episodes |
| Volume | Open the Bip 6 native Music controller to change the phone's media volume |

## Requirements

- Amazfit Bip 6 with Zepp OS 4.x
- Zepp app running on the paired phone
- Bluetooth connection between the phone and watch
- Internet access on the phone
- Spotify account with access to the required Web API playback features
- Node.js 20 and Zeus CLI for development

An active Spotify playback device is required for playback commands. Start a song on the phone if Spotify reports that no player is available.

## Sign in to Spotify

Authentication uses Spotify OAuth with PKCE. The app never asks for your Spotify password.

1. Install the mini app and open its settings page inside Zepp.
2. Tap **1) Prepare**.
3. Tap **2) Login** and approve the requested Spotify permissions.
4. Return to Zepp and wait for the **Logged in** status.
5. Start Spotify on the phone, then open **Spotify Control** on the watch.

If Spotify reports `insufficient client scope`, open the settings page, tap **Clear login**, and repeat the sign-in flow so the current permissions can be granted.

After updating from a version before 1.6.0, reconnect once so Spotify can grant the new permission used by the Like button.

<details>
  <summary><strong>Using your own Spotify application and callback server</strong></summary>

Create an application in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard), then enter its Client ID in the Zepp settings page. Add this redirect URI to the Spotify application:

```text
https://YOUR-AUTH-SERVER/api/callback
```

Enter the HTTPS server base URL—not the `/api/callback` path—in **Auth server URL**. The automatic flow expects compatible `/api/callback` and `/api/poll` endpoints. A manual authorization-code fallback is also available from the settings page.
</details>

## Build from source

Install [Node.js 20](https://nodejs.org/) and the Zepp OS command-line tools, then run:

```bash
npm install
npm test
npm run build
```

The installable `.zab` package is written to `dist/`. Install it through the Zepp developer-mode mini-app workflow.

## Project structure

```text
app-side/   Spotify Web API requests and artwork transfer
assets/     Watch icons and interface images
page/       Watch pages and responsive layouts
setting/    Spotify login and configuration page in Zepp
tests/      Regression tests
app.json    Zepp OS manifest
```

## Known limitations

- Spotify does not provide Web API operations for removing or reordering queue items. The app can view the queue and add new items.
- Phone volume is controlled by the watch's native Bluetooth Music controller, not by Spotify's API.
- Artwork starts downloading with the playback-state request and is transferred at a lightweight watch-friendly size.
- The app depends on the phone, Zepp background service, Spotify availability, and the permissions granted to the Spotify application.

### Playlists and radio

The playlist screen now follows Spotify's pagination instead of stopping at 50 entries. **Refresh playlists** fetches fresh data; if a later page fails, **Retry remaining playlists** keeps the entries already loaded. A profile lookup failure no longer blocks playlist browsing.

Spotify's API returns playlists you own or follow. Private and collaborative playlists require the corresponding login permissions; playlist folders are not returned. The phone's Home recommendations are not the same collection as this library endpoint. See [Spotify's playlist API](https://developer.spotify.com/documentation/web-api/reference/get-a-list-of-current-users-playlists) and [playlist behavior and permissions](https://developer.spotify.com/documentation/web-api/concepts/playlists).

Spotify restricts recommendations and algorithmic/editorial playlists for many development-mode apps. Loading all API pages cannot recover content the API withholds. See [Spotify's access restrictions](https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api).

Tap **Radio** beside a Liked Songs or Search result, or on the home screen for the current song. **Start radio** requests recommendations seeded by that song and plays the resulting finite set. It does not reproduce Spotify's continuously generated native radio. If recommendations are unavailable, **Play artist mix** searches for playable songs by the seed song's artists and starts a clearly labeled mix. No playlist is created or saved.

Liked Songs has **Previous** and **Next songs** buttons. All available covers on a page load with two requests at a time, prioritizing the focused row. Failed covers retry twice; tap the cover count to retry again.

## Responsiveness

- Play/pause updates immediately and sends an explicit command once playback state is known. Rapid taps are sent in order; failed commands restore the last confirmed state.
- Controls refresh playback as soon as Spotify acknowledges them. The home screen checks for song changes every 5 seconds while playing and every 15 seconds while paused, with a local progress clock between checks. These timers stop when the page is hidden.
- The phone starts artwork alongside the playback metadata reply, eliminating the usual separate cover request. Home uses the image nearest 64 px; larger images near 300 px are requested only when opening fullscreen. The small home cover can look softer. Both sizes come directly from Spotify and use [Zepp's image conversion](https://docs.zepp.com/docs/reference/side-service-api/image-convert/) before transfer.
- Recent converted home/fullscreen covers use eight reusable phone cache slots, plus 30 slots for Liked Songs. Received covers are shared across watch pages and indexed in local storage for reuse after restarting. Missing files and overwritten slots are invalidated. The app skips obsolete artwork and cancels older transfers when supported.
- Only the playback fields displayed by the watch cross the phone bridge. Playlists, Liked Songs, and search results are cached on the phone for 30 seconds; account changes invalidate that cache.

Network and Bluetooth latency still affect command completion and new artwork. The tests check request ordering, caching, error recovery, and page lifecycle behavior; physical-device timings need to be measured on the paired watch and phone.

## Development notes

- App ID: `26263`
- App version: `1.6.0` (build code `11`)
- Design width: `390`
- Target profile: `gt.s`
- Runtime API: Zepp OS `4.0`

If you publish a fork through the Zepp developer console, replace the local app ID with the ID assigned to your application.

---

<div align="center">
  Made for quick music control without taking the phone out of your pocket.
</div>
