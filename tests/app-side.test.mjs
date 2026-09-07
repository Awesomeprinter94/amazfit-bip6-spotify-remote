import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const sourceUrl = new URL('../app-side/index.js', import.meta.url)

async function createHarness(fetchHandler, now = () => Date.now()) {
  let serviceDefinition
  const source = (await readFile(sourceUrl, 'utf8')).replace(
    "import { BaseSideService } from '@zeppos/zml/base-side'",
    'const BaseSideService = (options) => options',
  )

  const context = vm.createContext({
    AppSideService: (definition) => { serviceDefinition = definition },
    Promise,
    JSON,
    Number,
    String,
    Array,
    Date: class extends Date { static now() { return now() } },
    Error,
    Math,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
    console: { log() {} },
  })
  new vm.Script(source, { filename: 'app-side/index.js' }).runInContext(context)

  const settings = new Map([
    ['spotifyAccessToken', 'valid-access-token-for-tests'],
    ['spotifyRefreshToken', 'valid-refresh-token-for-tests'],
    ['spotifyClientId', 'test-client-id'],
    ['spotifyExpiresAt', String(now() + 3600000)],
  ])
  const calls = []
  const side = {
    ...serviceDefinition,
    settings: {
      getItem: (key) => settings.get(key) || '',
      setItem: (key, value) => settings.set(key, value),
    },
    fetch: async (request) => {
      calls.push(request)
      return fetchHandler(request)
    },
  }

  const request = (action, params = {}) => new Promise((resolve, reject) => {
    side.onRequest.call(side, { method: `spotify.${action}`, params }, (error, response) => {
      if (error) reject(error)
      else resolve(response)
    })
  })

  return { side, calls, request, settings }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

function mockArtwork(side) {
  const downloads = []
  const conversions = []
  const transfers = []
  side.download = (url, options) => {
    const task = {}
    downloads.push({ url, options, task })
    queueMicrotask(() => task.onSuccess({ filePath: options.filePath, statusCode: 200 }))
    return task
  }
  side.convert = async (options) => {
    conversions.push(options)
    return { targetFilePath: options.targetFilePath }
  }
  side.sendFile = (path, params) => {
    transfers.push({ path, params })
    return { readyState: 'transferred' }
  }
  return { downloads, conversions, transfers }
}

test('explicit play/pause needs only one Spotify request per tap', async () => {
  const harness = await createHarness(async () => ({ status: 204 }))
  assert.equal((await harness.request('pause')).isPlaying, false)
  assert.equal((await harness.request('play')).isPlaying, true)
  assert.deepEqual(harness.calls.map(({ method, url }) => [method, url.split('/').pop()]), [
    ['PUT', 'pause'], ['PUT', 'play'],
  ])
})

test('metadata starts artwork without waiting for its download or a second watch request', async () => {
  const harness = await createHarness(() => ({ status: 200, body: {
    item: { id: 'song', uri: 'spotify:track:song', album: { id: 'album', images: [{ width: 300, url: 'large' }, { width: 64, url: 'small' }] } },
  } }))
  const art = mockArtwork(harness.side)
  let finish
  harness.side.download = (url, options) => {
    assert.equal(url, 'small')
    const task = {}
    finish = () => task.onSuccess({ filePath: options.filePath })
    return task
  }
  const response = await harness.request('getState', { art: true, knownAlbums: [] })
  assert.equal(response.data.item.uri, 'spotify:track:song')
  assert.equal(response.art.albumId, 'album')
  assert.equal(response.art.quality, 'preview')
  assert.equal(art.transfers.length, 0)
  finish()
  await flush()
  assert.equal(art.transfers.length, 1)
  const known = await harness.request('getState', { art: true, knownAlbums: ['album'] })
  assert.equal(known.art, null)
  assert.equal(art.transfers.length, 1)
})

test('simultaneous automatic and explicit cover requests share one transfer', async () => {
  const harness = await createHarness(() => ({ status: 204 }))
  const art = mockArtwork(harness.side)
  const params = { albumId: 'a', url: 'a', quality: 'preview' }
  await Promise.all([harness.request('getArt', params), harness.request('getArt', params)])
  assert.equal(art.downloads.length, 1)
  assert.equal(art.transfers.length, 1)
})

test('playlist pagination preserves metadata-only playlists even when profile lookup fails', async () => {
  const harness = await createHarness((request) => {
    if (request.url.endsWith('/me')) return { status: 403, body: { error: { message: 'Profile unavailable' } } }
    if (request.url.includes('offset=50')) return { status: 200, body: { offset: 50, total: 51, next: null, items: [{ id: 'last', name: 'Last playlist' }] } }
    return { status: 200, body: {
      offset: 0, total: 51, next: 'https://api.spotify.com/v1/me/playlists?offset=50&limit=50',
      items: Array.from({ length: 50 }, (_, i) => i === 2 ? null : { id: `id${i}`, name: `Playlist ${i}`, owner: { id: 'owner' } }),
    } }
  })
  const first = await harness.request('getPlaylists')
  assert.equal(first.success, true)
  assert.equal(first.items.length, 49)
  assert.equal(first.nextOffset, 50, 'paging counts raw items, including omitted nulls')
  assert.equal(first.items[0].uri, 'spotify:playlist:id0')
  assert.match(first.warning, /Owner information unavailable/)
  const last = await harness.request('getPlaylists', { offset: first.nextOffset })
  assert.equal(last.items[0].name, 'Last playlist')
  assert.equal(last.total, 51)
  assert.equal(last.nextOffset, null)
})

test('liked songs support later pages and image slots beyond the first six', async () => {
  const harness = await createHarness((request) => {
    assert.match(request.url, /\/me\/tracks\?limit=30&offset=30$/)
    return { status: 200, body: { total: 31, offset: 30, next: null, items: [{ item: { name: 'Last', uri: 'spotify:track:last' } }] } }
  })
  const result = await harness.request('getTracks', { offset: 30 })
  assert.equal(result.items[0].name, 'Last')
  assert.equal(result.nextOffset, null)
  const art = mockArtwork(harness.side)
  await harness.request('getTrackArt', { albumId: 'last', url: 'last', slot: 29 })
  assert.match(art.transfers[0].path, /thumb_29\.png$/)
})

test('manual playlist refresh bypasses cached pages and bad offsets fail before fetching', async () => {
  const harness = await createHarness((request) => ({ status: 200, body: request.url.endsWith('/me') ? { id: 'me' } : { items: [] } }))
  await harness.request('getPlaylists')
  await harness.request('getPlaylists')
  assert.equal(harness.calls.length, 2)
  await harness.request('getPlaylists', { refresh: true })
  assert.equal(harness.calls.length, 3)
  for (const offset of [-1, 1.5, 'not-a-page', 100001]) {
    assert.equal((await harness.request('getPlaylists', { offset })).success, false)
  }
  assert.equal(harness.calls.length, 3)
})

test('radio offers the artist mix when recommendations are restricted without changing playback', async () => {
  const harness = await createHarness((request) => {
    assert.match(request.url, /recommendations\?seed_tracks=seed&limit=20$/)
    return { status: 403, body: { error: { message: 'Forbidden' } } }
  })
  const response = await harness.request('startRadio', { uri: 'spotify:track:seed' })
  assert.equal(response.needsArtistMix, true)
  assert.equal(harness.calls.length, 1)
  assert.equal((await harness.request('startRadio', { uri: 'spotify:track:another' })).needsArtistMix, true)
  assert.equal(harness.calls.length, 1, 'known unsupported endpoint is not called repeatedly')
  assert.equal((await harness.request('startRadio', { uri: 'spotify:episode:podcast' })).success, false)
})

test('radio plays a deduplicated recommendation set and does not mask rate limits', async () => {
  const harness = await createHarness((request) => request.method === 'PUT' ? { status: 204 } : { status: 200, body: {
    tracks: [{ uri: 'spotify:track:seed' }, { uri: 'spotify:track:next' }, { uri: 'spotify:track:next' }, { uri: 'spotify:track:blocked', is_playable: false }],
  } })
  const response = await harness.request('startRadio', { uri: 'spotify:track:seed' })
  assert.equal(response.mode, 'recommendations')
  assert.equal(response.count, 2)
  assert.deepEqual(JSON.parse(harness.calls[1].body).uris, ['spotify:track:seed', 'spotify:track:next'])
  const limited = await createHarness(() => ({ status: 429 }))
  const error = await limited.request('startRadio', { uri: 'spotify:track:seed' })
  assert.equal(error.success, false)
  assert.equal(error.needsArtistMix, undefined)
})

test('artist mix matches the seed artists and excludes unrelated, unavailable and duplicate songs', async () => {
  const artist = { id: 'a', name: 'An Artist' }
  const harness = await createHarness((request) => {
    if (request.url.endsWith('/tracks/seed')) return { status: 200, body: { artists: [artist] } }
    if (request.url.includes('/search?')) {
      assert.match(request.url, /q=artist%3A%22An%20Artist%22/)
      return { status: 200, body: { tracks: { items: [
        { uri: 'spotify:track:seed', artists: [artist] },
        { uri: 'spotify:track:next', artists: [artist] },
        { uri: 'spotify:track:next', artists: [artist] },
        { uri: 'spotify:track:unrelated', artists: [{ id: 'other', name: 'Other' }] },
        { uri: 'spotify:track:blocked', artists: [artist], is_playable: false },
      ] } } }
    }
    return { status: 204 }
  })
  const response = await harness.request('startArtistMix', { uri: 'spotify:track:seed' })
  assert.equal(response.mode, 'artist-mix')
  assert.equal(response.count, 2)
  assert.deepEqual(JSON.parse(harness.calls[2].body).uris, ['spotify:track:seed', 'spotify:track:next'])
})

test('playback sends only watch fields and coalesces concurrent reads', async () => {
  let finish
  const markets = Array.from({ length: 100 }, (_, i) => `market-${i}`)
  const state = {
    is_playing: true, progress_ms: 5000, device: { name: 'Phone', id: 'secret-device', volume_percent: 70 },
    item: {
      id: 'song', name: 'Song', duration_ms: 180000, available_markets: markets,
      artists: [{ name: 'Artist', available_markets: markets }],
      album: { id: 'album', name: 'Album', available_markets: markets, images: [{ url: 'cover', width: 64, height: 64 }] },
    },
  }
  const harness = await createHarness(() => new Promise((resolve) => { finish = resolve }))
  const first = harness.request('getState')
  const second = harness.request('getState')
  await flush()
  assert.equal(harness.calls.length, 1)
  finish({ status: 200, body: state })
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.data.item.album.images[0].url, 'cover')
  assert.equal(b.data.progress_ms, 5000)
  assert.equal(a.data.device.name, 'Phone')
  assert.equal(a.data.item.available_markets, undefined)
  assert.ok(JSON.stringify(a.data).length < JSON.stringify(state).length / 5)

  const fresh = harness.request('getState')
  await flush()
  assert.equal(harness.calls.length, 2, 'completed playback reads are never reused')
  finish({ status: 200, body: state })
  await fresh
})

test('a playback command prevents a new read from joining a pre-command request', async () => {
  const reads = []
  const harness = await createHarness((request) => request.method === 'GET'
    ? new Promise((resolve) => reads.push(resolve))
    : { status: 204 })
  const old = harness.request('getState')
  await flush()
  await harness.request('pause')
  const fresh = harness.request('getState')
  await flush()
  assert.equal(reads.length, 2)
  reads[1]({ status: 200, body: { is_playing: false, item: { id: 'song' } } })
  assert.equal((await fresh).data.is_playing, false)
  reads[0]({ status: 200, body: { is_playing: true, item: { id: 'song' } } })
  await old
})

test('playlist/profile reads overlap; library cache expires and changes with login', async () => {
  let now = Date.now()
  const pending = []
  const harness = await createHarness((request) => new Promise((resolve) => pending.push({ request, resolve })), () => now)
  const first = harness.request('getPlaylists')
  await flush()
  assert.equal(pending.length, 2, 'profile starts before playlists finish')
  pending[0].resolve({ status: 200, body: { items: [] } })
  pending[1].resolve({ status: 200, body: { id: 'me' } })
  await first
  await harness.request('getPlaylists')
  assert.equal(harness.calls.length, 2)
  now += 31000
  const expired = harness.request('getPlaylists')
  await flush()
  assert.equal(harness.calls.length, 3, 'profile still cached, playlists refreshed')
  pending[2].resolve({ status: 200, body: { items: [] } })
  await expired
  harness.settings.set('spotifyRefreshToken', 'different-account')
  const switched = harness.request('getPlaylists')
  await flush()
  assert.equal(harness.calls.length, 5)
  pending[3].resolve({ status: 200, body: { items: [] } })
  pending[4].resolve({ status: 200, body: { id: 'new-user' } })
  await switched
})

test('failed library reads can be retried immediately', async () => {
  let fail = true
  const harness = await createHarness(() => fail ? { status: 503 } : { status: 200, body: { items: [] } })
  assert.equal((await harness.request('getTracks')).success, false)
  fail = false
  assert.equal((await harness.request('getTracks')).success, true)
  assert.equal(harness.calls.length, 2)
})

test('artwork reuses recent albums and keeps preview/full copies in bounded slots', async () => {
  const harness = await createHarness(() => ({ status: 204 }))
  const art = mockArtwork(harness.side)
  const request = (albumId, quality = 'full') => harness.request('getArt', { albumId, quality, url: `${albumId}-${quality}` })
  await request('a', 'preview')
  await request('a')
  await request('b')
  await request('a')
  assert.equal(art.downloads.length, 3)
  assert.equal(art.conversions.length, 3)
  assert.equal(art.transfers[1].path, art.transfers[3].path)
  assert.notEqual(art.transfers[0].path, art.transfers[1].path)
  for (let i = 0; i < 12; i += 1) await request(`album-${i}`)
  assert.equal(new Set(art.downloads.map(({ options }) => options.filePath)).size, 8)
})

test('obsolete artwork is skipped and a blocked download does not hold playback commands', async () => {
  const harness = await createHarness(() => ({ status: 204 }))
  const art = mockArtwork(harness.side)
  const download = harness.side.download
  let finish
  harness.side.download = (url, options) => {
    if (url !== 'a') return download(url, options)
    const task = {}
    finish = () => task.onSuccess({ filePath: options.filePath })
    return task
  }
  const a = harness.request('getArt', { albumId: 'a', url: 'a', quality: 'preview' })
  await flush()
  assert.equal((await harness.request('next')).success, true)
  const b = harness.request('getArt', { albumId: 'b', url: 'b' })
  const c = harness.request('getArt', { albumId: 'c', url: 'c' })
  finish()
  const results = await Promise.all([a, b, c])
  assert.equal(results[0].superseded, true)
  assert.equal(results[1].superseded, true)
  assert.equal(results[2].transferred, true)
  assert.deepEqual(art.downloads.map(({ url }) => url), ['c'])
  assert.deepEqual(art.transfers.map(({ params }) => params.albumId), ['c'])
})

test('a new album cancels an obsolete active transfer before sending its preview', async () => {
  const harness = await createHarness(() => ({ status: 204 }))
  const art = mockArtwork(harness.side)
  const send = harness.side.sendFile
  let canceled = false
  harness.side.sendFile = (path, params) => params.albumId === 'a'
    ? { readyState: 'pending', on() {}, cancel() { canceled = true } }
    : send(path, params)
  const a = harness.request('getArt', { albumId: 'a', url: 'a' })
  await flush()
  const b = harness.request('getArt', { albumId: 'b', url: 'b', quality: 'preview' })
  const results = await Promise.all([a, b])
  assert.equal(canceled, true)
  assert.equal(results[0].success, false)
  assert.equal(results[1].transferred, true)
  assert.equal(art.transfers[0].params.quality, 'preview')
})

test('thumbnail downloads overlap across slots but never overwrite a transferring slot', async () => {
  const harness = await createHarness(() => ({ status: 204 }))
  const art = mockArtwork(harness.side)
  let finish
  harness.side.sendFile = (path, params) => {
    if (params.albumId !== 'a') return { readyState: 'transferred' }
    return { readyState: 'pending', on(event, callback) { finish = () => callback({ data: { readyState: 'transferred' } }) } }
  }
  const a = harness.request('getTrackArt', { albumId: 'a', url: 'a', slot: 0 })
  await flush()
  const b = harness.request('getTrackArt', { albumId: 'b', url: 'b', slot: 0 })
  const c = harness.request('getTrackArt', { albumId: 'c', url: 'c', slot: 1 })
  await c
  assert.deepEqual(art.downloads.map(({ url }) => url), ['a', 'c'])
  finish()
  await Promise.all([a, b])
  assert.deepEqual(art.downloads.map(({ url }) => url), ['a', 'c', 'b'])
})

test('transport controls call the documented Spotify player endpoints', async () => {
  const harness = await createHarness(async (request) => {
    if (request.url.endsWith('/me/player') && request.method === 'GET') {
      return { status: 200, body: { is_playing: true, item: { name: 'Song' } } }
    }
    return { status: 204, body: '' }
  })

  assert.equal((await harness.request('previous')).success, true)
  assert.equal((await harness.request('next')).success, true)
  assert.equal((await harness.request('toggle')).isPlaying, false)

  assert.deepEqual(
    harness.calls.map(({ url, method }) => [url, method]),
    [
      ['https://api.spotify.com/v1/me/player/previous', 'POST'],
      ['https://api.spotify.com/v1/me/player/next', 'POST'],
      ['https://api.spotify.com/v1/me/player', 'GET'],
      ['https://api.spotify.com/v1/me/player/pause', 'PUT'],
    ],
  )
})

test('the current song can be liked and unliked with Spotify library endpoints', async () => {
  const harness = await createHarness(async (request) => {
    if (request.url.includes('/me/library/contains?')) {
      return { status: 200, body: [false] }
    }
    return { status: 200, body: '' }
  })
  const uri = 'spotify:track:4iV5W9uYEdYUVa79Axb7Rh'

  const initial = await harness.request('getLikeState', { uri })
  const liked = await harness.request('setLiked', { uri, liked: true })
  const unliked = await harness.request('setLiked', { uri, liked: false })

  assert.equal(initial.liked, false)
  assert.equal(liked.liked, true)
  assert.equal(unliked.liked, false)
  assert.deepEqual(
    harness.calls.map(({ url, method }) => [url, method]),
    [
      ['https://api.spotify.com/v1/me/library/contains?uris=spotify%3Atrack%3A4iV5W9uYEdYUVa79Axb7Rh', 'GET'],
      ['https://api.spotify.com/v1/me/library?uris=spotify%3Atrack%3A4iV5W9uYEdYUVa79Axb7Rh', 'PUT'],
      ['https://api.spotify.com/v1/me/library?uris=spotify%3Atrack%3A4iV5W9uYEdYUVa79Axb7Rh', 'DELETE'],
    ],
  )

  const invalid = await harness.request('setLiked', {
    uri: 'spotify:episode:not-a-song',
    liked: true,
  })
  assert.equal(invalid.success, false)
  assert.match(invalid.error, /not a Spotify song/i)
  assert.equal(harness.calls.length, 3)
})

test('queue can be viewed and changed by adding a Spotify item', async () => {
  const harness = await createHarness(async (request) => {
    if (request.url.endsWith('/me/player/queue')) {
      return {
        status: 200,
        body: {
          currently_playing: {
            name: 'Current Song',
            uri: 'spotify:track:current',
            type: 'track',
            artists: [{ name: 'Current Artist' }],
          },
          queue: [
            {
              name: 'Next Song',
              uri: 'spotify:track:next',
              type: 'track',
              artists: [{ name: 'Next Artist' }],
            },
            {
              name: 'Next Episode',
              uri: 'spotify:episode:podcast',
              type: 'episode',
              show: { name: 'Test Podcast' },
            },
          ],
        },
      }
    }
    return { status: 204, body: '' }
  })

  const queue = await harness.request('getQueue')
  assert.deepEqual(JSON.parse(JSON.stringify(queue.current)), {
    name: 'Current Song',
    subtitle: 'Current Artist',
    uri: 'spotify:track:current',
    type: 'track',
  })
  assert.deepEqual(JSON.parse(JSON.stringify(queue.items)), [
    {
      name: 'Next Song',
      subtitle: 'Next Artist',
      uri: 'spotify:track:next',
      type: 'track',
    },
    {
      name: 'Next Episode',
      subtitle: 'Test Podcast',
      uri: 'spotify:episode:podcast',
      type: 'episode',
    },
  ])

  const added = await harness.request('addToQueue', { uri: 'spotify:track:new-song' })
  assert.equal(added.uri, 'spotify:track:new-song')
  assert.deepEqual(
    harness.calls.map(({ url, method }) => [url, method]),
    [
      ['https://api.spotify.com/v1/me/player/queue', 'GET'],
      ['https://api.spotify.com/v1/me/player/queue?uri=spotify%3Atrack%3Anew-song', 'POST'],
    ],
  )
})

test('playlists and liked songs use non-player Spotify endpoints', async () => {
  const harness = await createHarness(async (request) => {
    if (request.url.endsWith('/me/playlists?limit=50')) {
      return {
        status: 200,
        body: {
          items: [
            {
              name: 'Road trip',
              uri: 'spotify:playlist:1',
              items: { total: 12 },
              owner: { id: 'me-user', display_name: 'Rafael' },
            },
            {
              name: 'Daily Drive',
              uri: 'spotify:playlist:2',
              items: { total: 40 },
              owner: { id: 'spotify', display_name: 'Spotify' },
            },
            {
              name: 'Shared songs',
              uri: 'spotify:playlist:3',
              tracks: { total: 8 },
              owner: { id: 'friend-user', display_name: 'A Friend' },
            },
          ],
        },
      }
    }
    if (request.url.endsWith('/me')) {
      return { status: 200, body: { id: 'me-user', account_id: 'stable-user', display_name: 'Rafael' } }
    }
    if (request.url.endsWith('/me/tracks?limit=30')) {
      return {
        status: 200,
        body: {
          items: [{
            track: {
              name: 'Dreams',
              uri: 'spotify:track:1',
              artists: [{ name: 'Artist' }],
              album: {
                id: 'album-1',
                images: [
                  { width: 300, url: 'https://i.scdn.co/large.jpg' },
                  { width: 64, url: 'https://i.scdn.co/tiny.jpg' },
                ],
              },
            },
          }],
        },
      }
    }
    throw new Error(`Unexpected URL ${request.url}`)
  })

  harness.settings.set('spotifyNeedsReconnect', '1')
  const playlists = await harness.request('getPlaylists')
  const tracks = await harness.request('getTracks')

  assert.deepEqual(JSON.parse(JSON.stringify(playlists.items)), [
    {
      name: 'Road trip',
      subtitle: '12 tracks · You',
      owner: 'You',
      source: 'mine',
      uri: 'spotify:playlist:1',
    },
    {
      name: 'Daily Drive',
      subtitle: '40 tracks · Spotify',
      owner: 'Spotify',
      source: 'spotify',
      uri: 'spotify:playlist:2',
    },
    {
      name: 'Shared songs',
      subtitle: '8 tracks · A Friend',
      owner: 'A Friend',
      source: 'other',
      uri: 'spotify:playlist:3',
    },
  ])
  assert.deepEqual(JSON.parse(JSON.stringify(tracks.items)), [
    {
      name: 'Dreams',
      subtitle: 'Artist',
      uri: 'spotify:track:1',
      albumId: 'album-1',
      artUrl: 'https://i.scdn.co/tiny.jpg',
    },
  ])
  assert.equal(harness.settings.get('spotifyNeedsReconnect'), '')
})

test('missing playlist scope gives actionable reconnect guidance', async () => {
  const harness = await createHarness(async () => ({
    status: 403,
    body: { error: { status: 403, message: 'Insufficient client scope' } },
  }))

  const response = await harness.request('getPlaylists')

  assert.equal(response.success, false)
  assert.match(response.error, /missing playlist access/i)
  assert.match(response.error, /Clear login, then Prepare and Login again/)
  assert.equal(harness.settings.get('spotifyNeedsReconnect'), '1')
})

test('search encodes the query and playing a result sends its URI', async () => {
  const harness = await createHarness(async (request) => {
    if (request.url.includes('/search?')) {
      return {
        status: 200,
        body: {
          tracks: { items: [{ name: 'Now You Know', uri: 'spotify:track:4', artists: [{ name: 'Mild Orange' }] }] },
        },
      }
    }
    return { status: 204, body: '' }
  })

  const result = await harness.request('searchTracks', { query: 'mild orange' })
  assert.equal(result.items[0].name, 'Now You Know')
  assert.match(harness.calls[0].url, /q=mild%20orange/)
  assert.match(harness.calls[0].url, /limit=10/)

  const played = await harness.request('playTrack', { uri: 'spotify:track:4' })
  assert.equal(played.success, true)
  assert.equal(harness.calls[1].url, 'https://api.spotify.com/v1/me/player/play')
  assert.deepEqual(JSON.parse(harness.calls[1].body), { uris: ['spotify:track:4'] })
})

test('album art uses explicit data paths and reports transfer completion', async () => {
  const harness = await createHarness(async () => ({ status: 200, body: {} }))
  let downloadOptions
  let convertedOptions
  let transferOptions

  harness.side.download = (url, options) => {
    downloadOptions = options
    const task = {}
    queueMicrotask(() => task.onSuccess({ filePath: options.filePath, statusCode: 200 }))
    return task
  }
  harness.side.convert = async (options) => {
    convertedOptions = options
    return { targetFilePath: options.targetFilePath }
  }
  harness.side.sendFile = (path, options) => {
    transferOptions = { path, options }
    return {
      readyState: 'pending',
      on(event, callback) {
        if (event === 'change') queueMicrotask(() => callback({ data: { readyState: 'transferred' } }))
      },
    }
  }

  const response = await harness.request('getArt', {
    url: 'https://i.scdn.co/cover.jpg',
    albumId: 'album-1',
  })

  assert.equal(response.success, true)
  assert.equal(downloadOptions.filePath, 'data://download/spotify_cover_0.jpg')
  assert.equal(convertedOptions.targetFilePath, 'data://download/spotify_cover_0.png')
  assert.deepEqual(JSON.parse(JSON.stringify(transferOptions)), {
    path: 'data://download/spotify_cover_0.png',
    options: { kind: 'spotify-cover', albumId: 'album-1', quality: 'full' },
  })

  const thumbnail = await harness.request('getTrackArt', {
    url: 'https://i.scdn.co/tiny.jpg',
    albumId: 'album-2',
    slot: 4,
  })

  assert.equal(thumbnail.success, true)
  assert.equal(downloadOptions.filePath, 'data://download/spotify_thumb_4.jpg')
  assert.equal(convertedOptions.targetFilePath, 'data://download/spotify_thumb_4.png')
  assert.deepEqual(JSON.parse(JSON.stringify(transferOptions)), {
    path: 'data://download/spotify_thumb_4.png',
    options: { kind: 'spotify-track-cover', albumId: 'album-2', slot: 4 },
  })
})

test('playback state is compact and starts transferring the watch-sized cover immediately', async () => {
  const harness = await createHarness(async (request) => ({
    status: 200,
    body: {
      is_playing: true,
      progress_ms: 12000,
      device: { name: 'Phone', volume_percent: 70, unnecessary: 'discard me' },
      item: {
        id: 'track-1',
        uri: 'spotify:track:4iV5W9uYEdYUVa79Axb7Rh',
        type: 'track',
        name: 'Fast Cover',
        duration_ms: 180000,
        artists: [{ name: 'Artist', href: 'discard me' }],
        available_markets: new Array(100).fill('BR'),
        album: {
          id: 'album-fast',
          images: [
            { width: 640, height: 640, url: 'https://i.scdn.co/large.jpg' },
            { width: 300, height: 300, url: 'https://i.scdn.co/medium.jpg' },
            { width: 64, height: 64, url: 'https://i.scdn.co/small.jpg' },
          ],
        },
      },
    },
  }))
  let downloadedUrl = ''
  let transferOptions

  harness.side.download = (url, options) => {
    downloadedUrl = url
    const task = {}
    queueMicrotask(() => task.onSuccess({ filePath: options.filePath, statusCode: 200 }))
    return task
  }
  harness.side.convert = async (options) => ({ targetFilePath: options.targetFilePath })
  harness.side.sendFile = (path, options) => {
    transferOptions = { path, options }
    return {
      readyState: 'pending',
      on(event, callback) {
        if (event === 'change') queueMicrotask(() => callback({ data: { readyState: 'transferred' } }))
      },
    }
  }

  const response = await harness.request('getState', { art: true, knownAlbums: [] })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(downloadedUrl, 'https://i.scdn.co/small.jpg')
  assert.deepEqual(JSON.parse(JSON.stringify(response.data)), {
    is_playing: true,
    progress_ms: 12000,
    device: { name: 'Phone' },
    item: {
      id: 'track-1',
      uri: 'spotify:track:4iV5W9uYEdYUVa79Axb7Rh',
      name: 'Fast Cover',
      duration_ms: 180000,
      artists: [{ name: 'Artist' }],
      album: {
        id: 'album-fast',
        images: [
          { url: 'https://i.scdn.co/large.jpg', width: 640 },
          { url: 'https://i.scdn.co/medium.jpg', width: 300 },
          { url: 'https://i.scdn.co/small.jpg', width: 64 },
        ],
      },
    },
  })
  assert.deepEqual(JSON.parse(JSON.stringify(transferOptions)), {
    path: 'data://download/spotify_cover_0.png',
    options: { kind: 'spotify-cover', albumId: 'album-fast', quality: 'preview' },
  })
})

test('watch source uses valid scroll, queue, filter, artwork, native phone volume, icon, and OAuth contracts', async () => {
  const [home, homeLayout, playlists, playlistLayout, tracks, cover, queue, queueLayout, settingsPage, icon, manifestText] = await Promise.all([
    readFile(new URL('../page/gt/home/index.page.js', import.meta.url), 'utf8'),
    readFile(new URL('../page/gt/home/index.page.s.layout.js', import.meta.url), 'utf8'),
    readFile(new URL('../page/gt/playlists/index.page.js', import.meta.url), 'utf8'),
    readFile(new URL('../page/gt/playlists/index.page.s.layout.js', import.meta.url), 'utf8'),
    readFile(new URL('../page/gt/tracks/index.page.js', import.meta.url), 'utf8'),
    readFile(new URL('../page/gt/cover/index.page.js', import.meta.url), 'utf8'),
    readFile(new URL('../page/gt/queue/index.page.js', import.meta.url), 'utf8'),
    readFile(new URL('../page/gt/queue/index.page.s.layout.js', import.meta.url), 'utf8'),
    readFile(new URL('../setting/index.js', import.meta.url), 'utf8'),
    readFile(new URL('../assets/gt.s/icon.png', import.meta.url)),
    readFile(new URL('../app.json', import.meta.url), 'utf8'),
  ])
  const manifest = JSON.parse(manifestText)

  assert.match(home, /setEnable\(false\)/)
  assert.match(home, /artWidget\.addEventListener\(hmUI\.event\.CLICK_DOWN/)
  assert.match(home, /page\/gt\/cover\/index\.page/)
  assert.match(home, /push\(\{ url:/)
  assert.doesNotMatch(home, /push\(\{ page:/)
  assert.match(home, /hmUI\.widget\.VIEW_CONTAINER/)
  assert.match(home, /setStatusBarVisible\(false\)/)
  assert.match(home, /SYSTEM_APP_MUSIC/)
  assert.match(home, /launchApp\(\{/)
  assert.match(home, /native: true/)
  assert.match(home, /page\/gt\/queue\/index\.page/)
  assert.match(home, /spotify\.getLikeState/)
  assert.match(home, /spotify\.setLiked/)
  assert.doesNotMatch(home, /page\/gt\/sound\/index\.page/)
  assert.match(homeLayout, /scroll_enable: 1/)
  assert.match(homeLayout, /DEVICE_HEIGHT \+ px\(64\)/)
  assert.match(playlists, /data_array: data/)
  assert.match(playlists, /data_count: data\.length/)
  assert.match(playlists, /hmUI\.prop\.VISIBLE/)
  assert.match(playlists, /Playlist error\\n\\n/)
  assert.match(playlists, /createKeyboard/)
  assert.match(playlists, /setFilter\('mine'\)/)
  assert.match(playlists, /setFilter\('spotify'\)/)
  assert.match(playlists, /item\.source !== filter/)
  assert.match(playlistLayout, /text_style: hmUI\.text_style\.WRAP/)
  assert.match(tracks, /data_array: data/)
  assert.match(tracks, /image_view:/)
  assert.match(tracks, /hmUI\.prop\.UPDATE_ITEM/)
  assert.match(tracks, /spotify\.getTrackArt/)
  assert.match(cover, /hmUI\.widget\.IMG/)
  assert.match(cover, /back\(\)/)
  assert.match(queue, /spotify\.getQueue/)
  assert.match(queue, /spotify\.addToQueue/)
  assert.match(queue, /spotify\.searchTracks/)
  assert.match(queue, /createKeyboard/)
  assert.match(queue, /Spotify does not allow queue reorder or removal\./)
  assert.match(queueLayout, /text: 'Search to add'/)
  assert.match(queueLayout, /Add works with Premium\./)
  assert.match(homeLayout, /text: 'Volume'/)
  assert.match(homeLayout, /text: 'Queue'/)
  assert.match(homeLayout, /text: '♡'/)
  assert.match(home, /liked \? '♥' : '♡'/)
  assert.match(settingsPage, /playlist-read-private/)
  assert.match(settingsPage, /playlist-read-collaborative/)
  assert.match(settingsPage, /user-read-private/)
  assert.match(settingsPage, /user-library-modify/)
  assert.match(settingsPage, /spotifyNeedsReconnect/)
  assert.ok(icon.length > 1000)
  assert.equal(manifest.app.icon, 'icon.png')
  assert.equal(manifest.app.version.name, '1.6.0')
  assert.equal(manifest.app.version.code, 11)
  assert.equal(manifest.targets.gt.designWidth, 390)
  assert.deepEqual(manifest.targets.gt.platforms, [{ st: 's' }])
  assert.ok(manifest.targets.gt.module.page.pages.includes('page/gt/cover/index.page'))
  assert.ok(manifest.targets.gt.module.page.pages.includes('page/gt/queue/index.page'))
  assert.ok(manifest.targets.gt.module.page.pages.includes('page/gt/radio/index.page'))
  assert.ok(!manifest.targets.gt.module.page.pages.includes('page/gt/sound/index.page'))
})
