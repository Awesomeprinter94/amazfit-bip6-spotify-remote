import { BaseSideService } from '@zeppos/zml/base-side'

const SPOTIFY_API = 'https://api.spotify.com/v1'
const ART_CACHE_LIMIT = 8
const RECONNECT_SETTING = 'spotifyNeedsReconnect'
const TRACK_PAGE_SIZE = 30

function getItem(side, key) {
  try {
    return side.settings.getItem(key) || ''
  } catch (error) {
    return ''
  }
}

function setItem(side, key, value) {
  try {
    side.settings.setItem(key, value)
  } catch (error) {
    console.log('[Side] unable to save setting', key)
  }
}

function getAccessToken(side) {
  return getItem(side, 'spotifyAccessToken') || getItem(side, 'spotifyToken')
}

function getRefreshToken(side) {
  return getItem(side, 'spotifyRefreshToken')
}

function getClientId(side) {
  return getItem(side, 'spotifyClientId') || '4454bd0035e849b886a23a1017e217a0'
}

function getExpiresAt(side) {
  return parseInt(getItem(side, 'spotifyExpiresAt') || '0', 10)
}

function parseResponseBody(response) {
  let body = response && response.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch (error) {
      body = body ? { message: body } : {}
    }
  }
  return body || {}
}

function getResponseStatus(response) {
  if (!response) return 0
  return Number(response.status || response.statusCode || 0)
}

async function refreshAccessToken(side) {
  if (side._refreshPromise) return side._refreshPromise

  side._refreshPromise = (async () => {
    const refreshToken = getRefreshToken(side)
    const clientId = getClientId(side)
    if (!refreshToken || !clientId) {
      throw new Error('Login expired. Open Spotify Control settings in Zepp and log in again.')
    }

    const response = await side.fetch({
      url: 'https://accounts.spotify.com/api/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `client_id=${encodeURIComponent(clientId)}&grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
      timeout: 15000,
    })
    const status = getResponseStatus(response)
    const body = parseResponseBody(response)

    if (status >= 400 || !body.access_token) {
      const detail = body.error_description || body.error || body.message || `HTTP ${status}`
      throw new Error(`Could not refresh Spotify login: ${detail}`)
    }

    const expiresAt = Date.now() + Number(body.expires_in || 3600) * 1000
    setItem(side, 'spotifyAccessToken', body.access_token)
    setItem(side, 'spotifyToken', body.access_token)
    setItem(side, 'spotifyExpiresAt', String(expiresAt))
    if (body.scope) setItem(side, 'spotifyScopes', String(body.scope))
    if (body.refresh_token) setItem(side, 'spotifyRefreshToken', body.refresh_token)
    return body.access_token
  })()

  try {
    return await side._refreshPromise
  } finally {
    side._refreshPromise = null
  }
}

async function ensureAccessToken(side) {
  let token = getAccessToken(side)
  if (!token) {
    throw new Error('Not logged in. Open Spotify Control settings in the Zepp app.')
  }

  const expiresAt = getExpiresAt(side)
  if (expiresAt && Date.now() >= expiresAt - 60000) {
    token = await refreshAccessToken(side)
  }
  return token
}

async function spotifyFetch(side, path, options = {}) {
  const url = path.indexOf('http') === 0 ? path : `${SPOTIFY_API}${path}`

  const perform = async (token) => {
    const request = {
      url,
      method: String(options.method || 'GET').toUpperCase(),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }
    if (options.body !== undefined) request.body = JSON.stringify(options.body)
    return side.fetch(request)
  }

  let token = await ensureAccessToken(side)
  let response
  try {
    response = await perform(token)
  } catch (error) {
    throw new Error(`Phone network error: ${error.message || String(error)}`)
  }

  let status = getResponseStatus(response)
  let body = parseResponseBody(response)

  if (status === 401 && getRefreshToken(side)) {
    token = await refreshAccessToken(side)
    response = await perform(token)
    status = getResponseStatus(response)
    body = parseResponseBody(response)
  }

  if (status === 204) return {}
  if (status >= 400) {
    const apiError = body.error || {}
    const detail = apiError.message || body.error_description || body.message || `HTTP ${status}`
    if (status === 401) throw new Error('Spotify login expired. Log in again in Zepp settings.')
    if (status === 403 && /insufficient client scope/i.test(String(detail))) {
      setItem(side, RECONNECT_SETTING, '1')
      const feature = path.indexOf('/me/playlists') === 0
        ? 'playlist access'
        : path.indexOf('/me/tracks') === 0 || path.indexOf('/me/library') === 0
          ? 'Liked Songs access'
          : 'the required permission'
      throw new Error(`Spotify login is missing ${feature}. In Zepp, open Spotify Control settings, tap Clear login, then Prepare and Login again.`)
    }
    if (status === 403) throw new Error(`Spotify denied this command: ${detail}`)
    if (status === 404 && path.indexOf('/me/player') === 0) throw new Error('No active Spotify player. Start a song on your phone first.')
    if (status === 429) throw new Error('Spotify is busy. Wait a moment and try again.')
    throw new Error(`Spotify error ${status}: ${detail}`)
  }

  if (path.indexOf('/me/playlists') === 0) setItem(side, RECONNECT_SETTING, '')
  return body
}

// Share concurrent reads and briefly reuse library data when pages are reopened.
// Playback state only shares an in-flight read; commands always force a new one.
function cachedRead(side, key, maxAge, read, force = false) {
  const account = getRefreshToken(side) || getAccessToken(side)
  if (side._cacheAccount !== account) {
    side._cacheAccount = account
    side._readCache = {}
  }
  const cache = side._readCache
  const cached = cache[key]
  if (cached && (cached.pending || (!force && Date.now() < cached.expiresAt))) return cached.promise
  const entry = { pending: true, expiresAt: 0 }
  entry.promise = Promise.resolve().then(read).then((value) => {
    entry.pending = false
    entry.expiresAt = Date.now() + maxAge
    return value
  }, (error) => {
    if (cache[key] === entry) delete cache[key]
    throw error
  })
  cache[key] = entry
  const keys = Object.keys(cache)
  if (keys.length > 12) {
    const oldest = keys.find((candidate) => candidate !== key && !cache[candidate].pending)
    if (oldest) delete cache[oldest]
  }
  return entry.promise
}

function compactState(state) {
  const item = state.item
  return {
    is_playing: !!state.is_playing,
    progress_ms: Number(state.progress_ms || 0),
    device: state.device ? { name: state.device.name || '' } : null,
    item: item ? {
      id: item.id || item.uri || '',
      uri: item.uri || (item.id ? `spotify:track:${item.id}` : ''),
      name: item.name || 'Unknown track',
      duration_ms: Number(item.duration_ms || 0),
      artists: (item.artists || []).filter(Boolean).map((artist) => ({ name: artist.name })),
      album: {
        id: (item.album && item.album.id) || item.id || '',
        images: ((item.album && item.album.images) || item.images || [])
          .filter((image) => image && image.url)
          .map((image) => ({ url: image.url, width: image.width || 0 })),
      },
    } : null,
  }
}

function downloadFile(side, url, filePath) {
  return new Promise((resolve, reject) => {
    let task
    try {
      task = side.download(url, {
        headers: { Accept: 'image/*' },
        timeout: 15000,
        filePath,
      })
    } catch (error) {
      reject(error)
      return
    }

    task.onSuccess = (event) => {
      if (event && event.statusCode >= 400) {
        reject(new Error(`Cover download failed: HTTP ${event.statusCode}`))
        return
      }
      resolve((event && (event.filePath || event.tempFilePath)) || filePath)
    }
    task.onFail = (event) => {
      reject(new Error(`Cover download failed: ${(event && (event.message || event.code)) || 'unknown error'}`))
    }
  })
}

function transferFile(side, path, params) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timeoutId = null
    let file
    let activeTransfer

    const finish = (error) => {
      if (settled) return
      settled = true
      if (timeoutId) clearTimeout(timeoutId)
      if (activeTransfer && side._activeArtTransfer === activeTransfer) side._activeArtTransfer = null
      if (error) reject(error)
      else resolve()
    }

    try {
      file = side.sendFile(path, params)
      if (file.readyState === 'transferred') {
        finish()
        return
      }
      if (params.kind === 'spotify-cover') {
        activeTransfer = {
          albumId: params.albumId,
          cancel() {
            if (typeof file.cancel !== 'function') return
            try {
              file.cancel()
              finish(new Error('Cover superseded'))
            } catch (error) {}
          },
        }
        side._activeArtTransfer = activeTransfer
      }
      file.on('change', (event) => {
        const state = event && event.data && event.data.readyState
        if (state === 'transferred') finish()
        else if (state === 'error' || state === 'canceled') {
          finish(new Error(`Cover transfer ${state}`))
        }
      })
      if (!settled) {
        timeoutId = setTimeout(() => {
          try {
            if (file && file.cancel) file.cancel()
          } catch (error) {}
          finish(new Error('Cover transfer timed out'))
        }, 20000)
      }
    } catch (error) {
      finish(error)
    }
  })
}

function supersedeArt(side, albumId = '') {
  side._wantedArtAlbum = albumId
  const active = side._activeArtTransfer
  if (active && active.albumId !== albumId) active.cancel()
}

async function prepareAndTransferArt(side, url, albumId, quality) {
  supersedeArt(side, albumId)
  const jobs = side._artJobs || (side._artJobs = {})
  const key = `${albumId}:${quality}:${url}`
  if (jobs[key]) return jobs[key]
  const previous = side._artQueue || Promise.resolve()
  const current = previous.catch(() => {}).then(async () => {
    const superseded = () => side._wantedArtAlbum !== albumId
    const skipped = { transferred: false, superseded: true, albumId, quality }
    if (superseded()) return skipped
    const cache = side._artCache || (side._artCache = [])
    let entry = cache.find((item) => item.albumId === albumId && item.url === url && item.quality === quality)
    if (!entry) {
      const slot = cache.length < ART_CACHE_LIMIT
        ? cache.length
        : cache.reduce((oldest, item) => item.used < oldest.used ? item : oldest).slot
      // Invalidate before overwriting a slot, including when download/convert fails.
      entry = { slot, albumId: '', used: 0 }
      cache[slot] = entry
      const downloadPath = `data://download/spotify_cover_${slot}.jpg`
      const targetPath = `data://download/spotify_cover_${slot}.png`
      const downloadedPath = await downloadFile(side, url, downloadPath)
      if (superseded()) return skipped
      const converted = await side.convert({
        filePath: downloadedPath,
        targetFilePath: targetPath,
      })
      Object.assign(entry, { albumId, url, quality, path: (converted && converted.targetFilePath) || targetPath })
    }
    entry.used = side._artUse = Number(side._artUse || 0) + 1
    if (superseded()) return skipped
    await transferFile(side, entry.path, { kind: 'spotify-cover', albumId, quality })
    return { transferred: true, albumId, quality }
  })

  side._artQueue = current
  side._artJob = { albumId, url, promise: current }
  jobs[key] = current
  try {
    return await current
  } finally {
    if (jobs[key] === current) delete jobs[key]
    if (side._artQueue === current) side._artQueue = null
    if (side._artJob && side._artJob.promise === current) side._artJob = null
  }
}

async function prepareAndTransferThumbnail(side, url, albumId, slot) {
  const safeSlot = Math.max(0, Math.min(TRACK_PAGE_SIZE - 1, Math.floor(Number(slot) || 0)))
  const queues = side._thumbnailQueues || (side._thumbnailQueues = {})
  const previous = queues[safeSlot] || Promise.resolve()
  const current = previous.catch(() => {}).then(() => transferThumbnail(side, url, albumId, safeSlot))
  queues[safeSlot] = current
  try {
    return await current
  } finally {
    if (queues[safeSlot] === current) delete queues[safeSlot]
  }
}

async function transferThumbnail(side, url, albumId, safeSlot) {
  side._thumbnailSlots = side._thumbnailSlots || {}
  const cached = side._thumbnailSlots[safeSlot]
  let convertedPath = cached && cached.albumId === albumId && cached.url === url ? cached.path : ''

  if (!convertedPath) {
    delete side._thumbnailSlots[safeSlot]
    const downloadPath = `data://download/spotify_thumb_${safeSlot}.jpg`
    const targetPath = `data://download/spotify_thumb_${safeSlot}.png`
    const downloadedPath = await downloadFile(side, url, downloadPath)
    const converted = await side.convert({
      filePath: downloadedPath,
      targetFilePath: targetPath,
    })
    convertedPath = (converted && converted.targetFilePath) || targetPath
    side._thumbnailSlots[safeSlot] = { albumId, url, path: convertedPath }
  }

  await transferFile(side, convertedPath, {
    kind: 'spotify-track-cover',
    albumId,
    slot: safeSlot,
  })
  return { transferred: true, albumId, slot: safeSlot }
}

function findImageNearWidth(images, targetWidth) {
  if (!Array.isArray(images)) return null
  let selected = null
  let bestDistance = Number.POSITIVE_INFINITY
  images.forEach((image) => {
    if (!image || !image.url) return
    const width = Number(image.width || 0)
    const distance = width > 0 ? Math.abs(width - targetWidth) : 10000
    if (distance < bestDistance) {
      selected = image
      bestDistance = distance
    }
  })
  return selected
}

function findThumbnail(images) {
  return findImageNearWidth(images, 64)
}

function requireTrackUri(value) {
  const uri = String(value || '').trim()
  if (!/^spotify:track:[A-Za-z0-9]+$/.test(uri)) {
    throw new Error('The current item is not a Spotify song that can be liked.')
  }
  return uri
}

function compactTrack(track) {
  const artists = Array.isArray(track.artists)
    ? track.artists.map((artist) => artist.name).filter(Boolean).join(', ')
    : ''
  const result = {
    name: track.name || 'Unknown track',
    subtitle: artists,
    uri: track.uri,
  }
  const album = track.album || {}
  const thumbnail = findThumbnail(album.images)
  if (album.id && thumbnail) {
    result.albumId = album.id
    result.artUrl = thumbnail.url
  }
  return result
}

function compactQueueItem(item) {
  if (!item) return null
  const artists = Array.isArray(item.artists)
    ? item.artists.map((artist) => artist && artist.name).filter(Boolean).join(', ')
    : ''
  const show = item.show || {}
  const subtitle = artists || show.name || item.publisher || (item.type === 'episode' ? 'Podcast episode' : 'Spotify')

  return {
    name: item.name || (item.type === 'episode' ? 'Untitled episode' : 'Unknown track'),
    subtitle,
    uri: item.uri || '',
    type: item.type || 'track',
  }
}

function compactPlaylist(item, profile) {
  const owner = (item && item.owner) || {}
  const ownerId = String(owner.id || '')
  const ownerName = String(owner.display_name || '')
  const currentUserId = String((profile && profile.id) || '')
  const currentUserName = String((profile && profile.display_name) || '')
  const isMine = !!(
    (currentUserId && ownerId === currentUserId)
    || (!currentUserId && currentUserName && ownerName === currentUserName)
  )
  const isSpotify = ownerId.toLowerCase() === 'spotify' || ownerName.toLowerCase() === 'spotify'
  const source = isMine ? 'mine' : isSpotify ? 'spotify' : 'other'
  const ownerLabel = isMine ? 'You' : ownerName || (isSpotify ? 'Spotify' : 'Unknown owner')
  const total = item && item.items && item.items.total !== undefined
    ? item.items.total
    : item && item.tracks && item.tracks.total !== undefined
      ? item.tracks.total
      : null
  const countLabel = total === null ? 'Playlist' : `${total} tracks`

  return {
    name: (item && item.name) || 'Untitled playlist',
    subtitle: `${countLabel} · ${ownerLabel}`,
    owner: ownerLabel,
    source,
    uri: item && (item.uri || (item.id ? `spotify:playlist:${item.id}` : '')),
  }
}

function pageOffset(value) {
  const number = Number(value || 0)
  if (!Number.isFinite(number) || number < 0 || number > 100000 || Math.floor(number) !== number) {
    throw new Error('Invalid library page. Refresh the list and try again.')
  }
  return number
}

function pageInfo(body, offset) {
  const count = (body.items || []).length
  const total = Number.isFinite(Number(body.total)) ? Number(body.total) : offset + count
  const match = String(body.next || '').match(/[?&]offset=(\d+)/)
  const next = match ? Number(match[1]) : offset + count
  return { offset, total, nextOffset: count && (body.next || total > offset + count) && next > offset ? next : null }
}

function startStateArtwork(side, data, knownAlbums) {
  const album = data.item && data.item.album
  if (!album || !album.id || (Array.isArray(knownAlbums) && knownAlbums.indexOf(album.id) >= 0)) return null
  const image = findThumbnail(album.images)
  if (!image) return null
  const quality = Number(image.width) > 128 ? 'full' : 'preview'
  // Start before the metadata reply. Artwork must not add latency to getState.
  prepareAndTransferArt(side, image.url, album.id, quality).catch((error) => {
    console.log('[Side] automatic cover failed', error.message || String(error))
    if (typeof side.call === 'function') {
      Promise.resolve(side.call({ method: 'spotify.artFailed', params: { albumId: album.id } })).catch(() => {})
    }
  })
  return { albumId: album.id, quality }
}

function trackId(uri) {
  const match = String(uri || '').match(/^spotify:track:([a-zA-Z0-9]+)$/)
  if (!match) throw new Error('Radio needs a Spotify song, not an episode or local file.')
  return match[1]
}

async function startRadio(side, uri) {
  const id = trackId(uri)
  const account = getRefreshToken(side) || getAccessToken(side)
  if (side._radioUnavailableAccount === account) return { needsArtistMix: true }
  let recommendations
  try {
    recommendations = await spotifyFetch(side, `/recommendations?seed_tracks=${id}&limit=20`)
  } catch (error) {
    // These endpoints are unavailable to many development-mode applications.
    // Network/login/rate-limit failures must still be shown as failures.
    if (/Spotify denied this command|Spotify error 404/.test(error.message || '')) {
      side._radioUnavailableAccount = account
      return { needsArtistMix: true }
    }
    throw error
  }
  const uris = [uri]
  ;(recommendations.tracks || []).forEach((track) => {
    if (track && track.is_playable !== false && /^spotify:track:/.test(track.uri || '') && uris.indexOf(track.uri) < 0) uris.push(track.uri)
  })
  if (uris.length < 2) return { needsArtistMix: true }
  supersedeArt(side)
  side._playbackVersion = Number(side._playbackVersion || 0) + 1
  await spotifyFetch(side, '/me/player/play', { method: 'PUT', body: { uris } })
  return { mode: 'recommendations', count: uris.length }
}

async function startArtistMix(side, uri) {
  const id = trackId(uri)
  const seed = await spotifyFetch(side, `/tracks/${id}`)
  const artists = (seed.artists || []).filter((artist) => artist && artist.name).slice(0, 3)
  if (!artists.length) throw new Error('This song has no artist information for a mix.')
  const groups = await Promise.all(artists.map(async (artist) => {
    const query = `artist:"${String(artist.name).replace(/"/g, '')}"`
    const body = await spotifyFetch(side, `/search?q=${encodeURIComponent(query)}&type=track&limit=10`)
    return ((body.tracks && body.tracks.items) || []).filter((track) => track && track.is_playable !== false
      && (track.artists || []).some((candidate) => candidate && (artist.id && candidate.id
        ? artist.id === candidate.id : String(candidate.name).toLowerCase() === artist.name.toLowerCase())))
  }))
  const uris = [uri]
  // Interleave artists and avoid repeating the seed or duplicate tracks.
  for (let index = 0; index < 10; index += 1) {
    groups.forEach((group) => {
      const track = group[index]
      if (track && /^spotify:track:/.test(track.uri || '') && uris.indexOf(track.uri) < 0) uris.push(track.uri)
    })
  }
  if (uris.length < 2) throw new Error('No other playable songs by this artist were found.')
  supersedeArt(side)
  side._playbackVersion = Number(side._playbackVersion || 0) + 1
  await spotifyFetch(side, '/me/player/play', { method: 'PUT', body: { uris } })
  return { mode: 'artist-mix', count: uris.length }
}

AppSideService(
  BaseSideService({
    onInit() {
      console.log('[Side] Spotify service ready')
    },

    onRequest(req, res) {
      const method = String((req && req.method) || '')
      const action = method.indexOf('.') >= 0 ? method.split('.').pop() : method
      const params = (req && req.params) || {}
      let replied = false

      const reply = (payload) => {
        if (replied) return
        replied = true
        res(null, payload)
      }
      const ok = (payload = {}) => reply({ success: true, ...payload })
      const fail = (error) => reply({ success: false, error: error.message || String(error) })

      ;(async () => {
        if (action === 'ping') {
          const token = getAccessToken(this)
          return { hasToken: token.length > 20, hasRefresh: !!getRefreshToken(this) }
        }

        if (action === 'getState') {
          const version = this._playbackVersion || 0
          const result = await cachedRead(this, `state:${version}`, 0, async () => {
            const state = await spotifyFetch(this, '/me/player')
            if (state.item) return { data: compactState(state) }
            const current = await spotifyFetch(this, '/me/player/currently-playing')
            return { data: compactState(current.item ? { ...current, device: state.device } : state) }
          })
          const art = params.art && version === (this._playbackVersion || 0)
            ? startStateArtwork(this, result.data, params.knownAlbums) : null
          return { ...result, art }
        }

        if (action === 'toggle') {
          supersedeArt(this)
          this._playbackVersion = Number(this._playbackVersion || 0) + 1
          const state = await spotifyFetch(this, '/me/player')
          const isPlaying = !!state.is_playing
          await spotifyFetch(this, isPlaying ? '/me/player/pause' : '/me/player/play', { method: 'PUT' })
          return { isPlaying: !isPlaying }
        }

        const controls = {
          play: { path: '/me/player/play', method: 'PUT' },
          pause: { path: '/me/player/pause', method: 'PUT' },
          next: { path: '/me/player/next', method: 'POST' },
          previous: { path: '/me/player/previous', method: 'POST' },
          prev: { path: '/me/player/previous', method: 'POST' },
        }
        if (controls[action]) {
          const command = controls[action]
          supersedeArt(this)
          this._playbackVersion = Number(this._playbackVersion || 0) + 1
          await spotifyFetch(this, command.path, { method: command.method })
          return action === 'play' || action === 'pause' ? { isPlaying: action === 'play' } : {}
        }

        if (action === 'getPlaylists') {
          const offset = pageOffset(params.offset)
          return cachedRead(this, `playlists:${offset}`, 30000, async () => {
            const [body, profile] = await Promise.all([
              spotifyFetch(this, `/me/playlists?limit=50${offset ? `&offset=${offset}` : ''}`),
              cachedRead(this, 'profile', 300000, () => spotifyFetch(this, '/me')).catch(() => null),
            ])
            const scopes = getItem(this, 'spotifyScopes')
            const missingScopes = scopes && ['playlist-read-private', 'playlist-read-collaborative']
              .some((scope) => scopes.split(/\s+/).indexOf(scope) < 0)
            return {
              ...pageInfo(body, offset),
              items: (body.items || []).filter((item) => item && (item.uri || item.id)).map((item) => compactPlaylist(item, profile)),
              warning: missingScopes ? 'Private/shared playlists need a new login in Zepp settings.'
                : !profile ? 'Owner information unavailable; use All to see every returned playlist.' : '',
            }
          }, !!params.refresh)
        }

        if (action === 'getTracks') {
          const offset = pageOffset(params.offset)
          return cachedRead(this, `tracks:${offset}`, 30000, async () => {
            const body = await spotifyFetch(this, `/me/tracks?limit=${TRACK_PAGE_SIZE}${offset ? `&offset=${offset}` : ''}`)
            return { ...pageInfo(body, offset), items: (body.items || []).map((entry) => entry && (entry.track || entry.item)).filter((track) => track && track.uri).map(compactTrack) }
          }, !!params.refresh)
        }

        if (action === 'getLikeState') {
          const uri = requireTrackUri(params.uri)
          const body = await spotifyFetch(this, `/me/library/contains?uris=${encodeURIComponent(uri)}`)
          return { uri, liked: Array.isArray(body) && body[0] === true }
        }

        if (action === 'setLiked') {
          const uri = requireTrackUri(params.uri)
          const liked = params.liked === true
          await spotifyFetch(this, `/me/library?uris=${encodeURIComponent(uri)}`, {
            method: liked ? 'PUT' : 'DELETE',
          })
          return { uri, liked }
        }

        if (action === 'getQueue') {
          const body = await spotifyFetch(this, '/me/player/queue')
          const current = compactQueueItem(body.currently_playing)
          const items = (body.queue || [])
            .map(compactQueueItem)
            .filter(Boolean)
            .slice(0, 50)
          return { current, items }
        }

        if (action === 'addToQueue') {
          const uri = String(params.uri || '').trim()
          if (!/^spotify:(track|episode):/.test(uri)) {
            throw new Error('Only a Spotify track or episode can be added to the queue.')
          }
          await spotifyFetch(this, `/me/player/queue?uri=${encodeURIComponent(uri)}`, {
            method: 'POST',
          })
          return { uri }
        }

        if (action === 'searchTracks') {
          const query = String(params.query || '').trim()
          if (!query) throw new Error('Type a song, artist, or album first.')
          return cachedRead(this, `search:${query}`, 30000, async () => {
            const body = await spotifyFetch(this, `/search?q=${encodeURIComponent(query)}&type=track&limit=10`)
            const tracks = (body.tracks && body.tracks.items) || []
            return { items: tracks.filter((track) => track && track.uri).map(compactTrack) }
          })
        }

        if (action === 'playContext') {
          if (!params.uri) throw new Error('Playlist is missing its Spotify URI.')
          supersedeArt(this)
          this._playbackVersion = Number(this._playbackVersion || 0) + 1
          await spotifyFetch(this, '/me/player/play', {
            method: 'PUT',
            body: { context_uri: params.uri },
          })
          return {}
        }

        if (action === 'playTrack') {
          if (!params.uri) throw new Error('Track is missing its Spotify URI.')
          supersedeArt(this)
          this._playbackVersion = Number(this._playbackVersion || 0) + 1
          await spotifyFetch(this, '/me/player/play', {
            method: 'PUT',
            body: { uris: [params.uri] },
          })
          return {}
        }

        if (action === 'startRadio') return startRadio(this, String(params.uri || ''))
        if (action === 'startArtistMix') return startArtistMix(this, String(params.uri || ''))

        if (action === 'getArt') {
          if (!params.url || !params.albumId) throw new Error('Cover request is incomplete.')
          return prepareAndTransferArt(this, params.url, params.albumId, params.quality === 'preview' ? 'preview' : 'full')
        }

        if (action === 'getTrackArt') {
          if (!params.url || !params.albumId) throw new Error('Track cover request is incomplete.')
          return prepareAndTransferThumbnail(this, params.url, params.albumId, params.slot)
        }

        throw new Error(`Unknown request: ${action}`)
      })().then(ok).catch(fail)
    },

    onSettingsChange({ key }) {
      if (key === 'spotifyAccessToken' || key === 'spotifyRefreshToken') {
        console.log('[Side] Spotify login updated')
      }
    },

    onDestroy() {
      console.log('[Side] Spotify service stopped')
    },
  }),
)
