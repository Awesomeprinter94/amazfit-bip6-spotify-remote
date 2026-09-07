import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const flush = () => new Promise((resolve) => setImmediate(resolve))
const track = (id = 'song', artwork = false) => ({
  id, name: id, artists: [{ name: 'Artist' }], duration_ms: 180000,
  album: {
    id: `album-${id}`,
    images: artwork ? [{ width: 300, url: `${id}-300` }, { width: 64, url: `${id}-64` }] : [],
  },
})
const playback = (item = track(), playing = true) => ({
  success: true, data: { item, is_playing: playing, progress_ms: 5000, device: { name: 'Phone' } },
})

async function createHarness(pageName = 'home', params, shared = { globalData: {}, storage: new Map(), files: new Map() }) {
  let page
  let now = 10000
  let timerId = 0
  const timers = new Map()
  const calls = []
  const routes = []
  const source = await readFile(new URL(`../page/gt/${pageName}/index.page.js`, import.meta.url), 'utf8')
  const layoutImport = source.match(/import \{([^}]+)\} from 'zosLoader:[^']+'/)[1]
  const styles = Object.fromEntries(layoutImport.split(',').map((name) => name.trim()).filter(Boolean).map((name) => [name, { w: 300 }]))
  styles.ART_STYLE = { w: 134, src: 'image/art_placeholder.png' }
  const widget = (type, options) => ({
    options: { ...options },
    createWidget: widget,
    addEventListener() {},
    setEnable() {},
    setProperty(prop, value) {
      if (prop === 'MORE') Object.assign(this.options, value)
      else this.options[prop.toLowerCase()] = value
    },
  })
  const constants = new Proxy({}, { get: (target, key) => key })
  const context = vm.createContext({
    ...styles,
    hmUI: { createWidget: widget, deleteWidget() {}, setStatusBarVisible() {}, widget: constants, prop: constants, event: constants, align: constants, text_style: constants },
    BasePage: (definition) => definition,
    Page: (definition) => { page = definition },
    Logger: { getLogger: () => ({ error() {} }) },
    Date: class extends Date { static now() { return now } },
    setTimeout(callback, delay) { timers.set(++timerId, { at: now + delay, callback }); return timerId },
    clearTimeout(id) { timers.delete(id) },
    px: (value) => value,
    push: (route) => routes.push(route),
    back() {}, launchApp() {}, SYSTEM_APP_MUSIC: 1,
    getApp: () => ({ _options: { globalData: shared.globalData } }),
    localStorage: { getItem: (key) => shared.storage.get(key), setItem: (key, value) => shared.storage.set(key, value) },
    statSync: ({ path }) => shared.files.get(path),
  })
  const artworkSource = await readFile(new URL('../utils/artwork.js', import.meta.url), 'utf8')
  new vm.Script(artworkSource.replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, '')).runInContext(context)
  new vm.Script(source.replace(/^import\s[\s\S]*?from '[^']+'\n/gm, '')).runInContext(context)
  if (page.onReceivedFile) {
    const onFile = page.onReceivedFile
    page.onReceivedFile = function (file) {
      if (file && file.readyState === 'transferred') shared.files.set(file.filePath, { size: 100 })
      onFile.call(this, file)
    }
  }
  page.request = (request) => new Promise((resolve, reject) => calls.push({ ...request, resolve, reject }))
  page.onInit(params)
  page.build()
  return {
    page, calls, timers, routes, shared,
    async reply(index, response = { success: true }) { calls[index].resolve(response); await flush() },
    async advance(ms) {
      const until = now + ms
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        timers.delete(next[0])
        now = next[1].at
        next[1].callback()
        await flush()
      }
      now = until
    },
  }
}

test('play/pause changes instantly and rapid taps are sent in order without a fixed wait', async () => {
  const h = await createHarness()
  await h.reply(0, playback())
  h.page.handleControl('toggle')
  assert.equal(h.page.playIcon.options.src, 'image/icon_play.png')
  assert.equal(h.calls[1].method, 'spotify.pause')
  h.page.handleControl('toggle')
  assert.equal(h.page.playIcon.options.src, 'image/icon_pause.png')
  assert.equal(h.calls.length, 2, 'second command waits for the first acknowledgement')
  await h.reply(1, { success: true, isPlaying: false })
  assert.equal(h.calls[2].method, 'spotify.play')
  assert.equal(h.page.state.isPlaying, true, 'old acknowledgement cannot undo the latest tap')
  await h.reply(2, { success: true, isPlaying: true })
  assert.equal(h.page.state.busy, false)
  assert.equal(h.calls[3].method, 'spotify.getState', 'refresh starts without advancing the clock')
  h.page.onDestroy()
})

test('failed controls restore confirmed playback and discard dependent queued taps', async () => {
  const h = await createHarness()
  await h.reply(0, playback())
  h.page.handleControl('toggle')
  h.page.handleControl('next')
  await h.reply(1, { success: false, error: 'Phone disconnected' })
  assert.equal(h.page.state.isPlaying, true)
  assert.equal(h.page.state.busy, false)
  assert.equal(h.page.titleWidget.options.text, 'song')
  assert.match(h.page.artistWidget.options.text, /disconnected/)
  assert.equal(h.calls.length, 2)
  await h.advance(1500)
  assert.equal(h.calls[2].method, 'spotify.getState')
  h.page.onDestroy()
})

test('pre-command and temporarily stale Spotify responses cannot undo an optimistic pause', async () => {
  const h = await createHarness()
  await h.reply(0, playback())
  h.page.refresh(true)
  h.page.handleControl('toggle')
  await h.reply(1, playback())
  assert.equal(h.page.state.isPlaying, false)
  await h.reply(2, { success: true, isPlaying: false })
  await h.reply(3, playback())
  assert.equal(h.page.state.isPlaying, false)
  await h.advance(250)
  assert.equal(h.calls[4].method, 'spotify.getState')
  await h.reply(4, playback(track(), false))
  assert.equal(h.page.state.isPlaying, false)
  assert.equal(h.page._expectedState, null)
  h.page.onDestroy()
})

test('progress advances locally and timers stop while the page is hidden or destroyed', async () => {
  const h = await createHarness()
  await h.reply(0, playback())
  await h.advance(3000)
  assert.equal(h.page.elapsedWidget.options.text, '0:08')
  assert.equal(h.calls.length, 1, 'smooth progress needs no extra network reads')
  h.page.onPause()
  assert.equal(h.timers.size, 0)
  await h.advance(10000)
  assert.equal(h.calls.length, 1)
  h.page.onResume()
  assert.equal(h.calls[1].method, 'spotify.getState')
  h.page.onDestroy()
  await h.reply(1, playback(track('new')))
  assert.equal(h.timers.size, 0)
  assert.equal(h.page.titleWidget.options.text, 'song')
})

test('a failed reconciliation does not cause an immediate polling loop', async () => {
  const h = await createHarness()
  await h.reply(0, playback())
  h.page.handleControl('toggle')
  await h.reply(1, { success: true, isPlaying: false })
  await h.reply(2, { success: false, error: 'Spotify is busy' })
  assert.equal(h.page._expectedState, null)
  await h.advance(1000)
  assert.equal(h.calls.length, 3)
  assert.equal(h.page.titleWidget.options.text, 'song')
  h.page.onDestroy()
})

function deliverCover(page, albumId, quality, path) {
  page.onReceivedFile({
    readyState: 'transferred', filePath: path,
    params: JSON.stringify({ kind: 'spotify-cover', albumId, quality }),
  })
}

test('home uses small artwork without background full transfers and reuses recently viewed covers', async () => {
  const h = await createHarness()
  await h.reply(0, playback(track('a', true)))
  assert.equal(h.calls[1].params.url, 'a-64')
  assert.equal(h.calls[1].params.quality, 'preview')
  deliverCover(h.page, 'album-a', 'preview', 'preview-a.png')
  assert.equal(h.page.artWidget.options.src, 'preview-a.png')
  await h.reply(1)
  await h.advance(999)
  assert.equal(h.calls.length, 2)
  await h.advance(1)
  assert.equal(h.calls.length, 2, 'full artwork is reserved for fullscreen viewing')
  deliverCover(h.page, 'album-a', 'full', 'full-a.png')
  deliverCover(h.page, 'album-a', 'preview', 'preview-a.png')
  assert.equal(h.page.artWidget.options.src, 'full-a.png', 'a late preview cannot downgrade the full cover')
  h.page.requestCover(track('b', true))
  const count = h.calls.length
  h.page.requestCover(track('a', true))
  assert.equal(h.page.artWidget.options.src, 'full-a.png')
  assert.equal(h.calls.length, count, 'cached artwork needs no Bluetooth request')
  h.page.onDestroy()
})

test('old covers cannot replace a new song and reused file slots invalidate old cache entries', async () => {
  const h = await createHarness()
  await h.reply(0, playback(track('a', true)))
  deliverCover(h.page, 'album-a', 'full', 'slot-0.png')
  await h.reply(1)
  h.page.requestCover(track('b', true))
  deliverCover(h.page, 'album-a', 'preview', 'old.png')
  assert.equal(h.page.artWidget.options.src, 'image/art_placeholder.png')
  deliverCover(h.page, 'album-b', 'full', 'slot-0.png')
  h.page.requestCover(track('a', true))
  assert.notEqual(h.page.artWidget.options.src, 'slot-0.png')
  h.page.onDestroy()
})

test('changing songs never queues full-size artwork in the background', async () => {
  const h = await createHarness()
  await h.reply(0, playback(track('a', true)))
  deliverCover(h.page, 'album-a', 'preview', 'a.png')
  await h.reply(1)
  h.page.requestCover(track('b', true))
  await h.advance(1000)
  assert.equal(h.calls.some((call) => call.params.url === 'a-300'), false)
  h.page.onDestroy()
})

test('a delayed transfer cannot replace the file behind the currently displayed cached album', async () => {
  const h = await createHarness()
  await h.reply(0, playback(track('a', true)))
  deliverCover(h.page, 'album-a', 'full', 'slot-0.png')
  await h.reply(1)
  deliverCover(h.page, 'album-b', 'full', 'slot-0.png')
  assert.equal(h.page.artWidget.options.src, 'image/art_placeholder.png')
  assert.equal(h.calls[2].params.albumId, 'album-a')
  h.page.onDestroy()
})

test('fullscreen opens the available preview and upgrades to matching full artwork', async () => {
  const h = await createHarness('cover', { src: 'preview.png', albumId: 'a', url: 'a-300' })
  assert.equal(h.page.coverWidget.options.src, 'preview.png')
  assert.equal(h.calls[0].params.quality, 'full')
  deliverCover(h.page, 'b', 'full', 'b.png')
  assert.equal(h.page.coverWidget.options.src, 'preview.png')
  deliverCover(h.page, 'a', 'full', 'a.png')
  assert.equal(h.page.coverWidget.options.src, 'a.png')
  h.page.onDestroy()
  deliverCover(h.page, 'a', 'full', 'late.png')
  assert.equal(h.page.coverWidget.options.src, 'a.png')
})

test('fullscreen reuses a full cover and recovers if a delayed transfer overwrites its slot', async () => {
  const h = await createHarness('cover', { src: 'slot-0.png', albumId: 'a', url: 'a-300', quality: 'full' })
  assert.equal(h.calls.length, 0)
  deliverCover(h.page, 'b', 'full', 'slot-0.png')
  assert.equal(h.page.coverWidget.options.src, 'image/art_placeholder.png')
  assert.equal(h.calls[0].params.albumId, 'a')
  h.page.onDestroy()
})

test('queue refresh keeps existing rows visible and adding a result has no fixed wait', async () => {
  const h = await createHarness('queue')
  await h.reply(0, { success: true, current: null, items: [{ name: 'Queued song', uri: 'spotify:track:a' }] })
  const list = h.page.listWidget
  h.page.loadQueue('', true)
  assert.equal(h.page.listWidget, list)
  assert.equal(h.page.state.items[0].name, 'Queued song')
  await h.reply(1, { success: true, current: null, items: [] })
  h.page.state.mode = 'search'
  h.page.state.items = [{ name: 'New song', uri: 'spotify:track:b' }]
  h.page.addToQueue(0)
  await h.reply(2)
  assert.equal(h.calls[3].method, 'spotify.getQueue')
  h.page.onDestroy()
})

test('liked-song previews have at most two requests in flight and stop after navigation', async () => {
  const h = await createHarness('tracks')
  await h.reply(0, { success: true, items: Array.from({ length: 6 }, (_, i) => ({ name: `Song ${i}`, albumId: `a${i}`, artUrl: `${i}.jpg` })) })
  assert.equal(h.calls.length, 3)
  await h.reply(1)
  assert.equal(h.calls.length, 4)
  assert.equal(h.calls[3].params.slot, 2)
  h.page.onDestroy()
  await h.reply(2)
  await h.reply(3)
  assert.equal(h.calls.length, 4)
})

test('all 30 liked-song covers load, including rows beyond six, with two requests at a time', async () => {
  const h = await createHarness('tracks')
  const items = Array.from({ length: 30 }, (_, i) => ({ name: `Song ${i}`, albumId: `album${i}`, artUrl: `${i}.jpg`, uri: `spotify:track:song${i}` }))
  await h.reply(0, { success: true, total: 90, nextOffset: 30, items })
  for (let i = 1; i <= 30; i += 1) {
    assert.ok(h.calls[i], `request for cover ${i} exists`)
    assert.ok(h.page._thumbnailActive <= 2)
    const request = h.calls[i]
    h.page.onReceivedFile({ readyState: 'transferred', filePath: `thumb-${request.params.slot}.png`, params: {
      kind: 'spotify-track-cover', albumId: request.params.albumId,
    } })
    await h.reply(i, { success: true, transferred: true })
  }
  assert.equal(h.calls.length, 31)
  assert.ok(h.page.state.items.every((item) => item.coverPath !== 'image/art_placeholder.png'))
  assert.match(h.page.statusWidget.options.text, /30\/30 covers/)
  h.page.nextPageWidget.options.click_func()
  assert.equal(h.calls[31].params.offset, 30)
  h.page.onDestroy()
})

test('failed liked covers retry twice, then can be retried explicitly without blocking other rows', async () => {
  const h = await createHarness('tracks')
  await h.reply(0, { success: true, items: [{ name: 'Song', albumId: 'a', artUrl: 'a.jpg' }] })
  await h.reply(1, { success: false, error: 'Transfer failed' })
  assert.equal(h.calls.length, 3)
  await h.reply(2, { success: false, error: 'Transfer failed' })
  assert.equal(h.calls.length, 3)
  assert.equal(h.page._thumbnailActive, 0)
  h.page.retryImages()
  assert.equal(h.calls.length, 4)
  h.page.onDestroy()
})

test('liked covers prioritize the row reached by scrolling', async () => {
  const h = await createHarness('tracks')
  await h.reply(0, { success: true, items: Array.from({ length: 30 }, (_, i) => ({ albumId: `a${i}`, artUrl: `${i}.jpg` })) })
  h.page.listWidget.options.item_focus_change_func(h.page.listWidget, 20, true)
  await h.reply(1)
  assert.equal(h.calls[3].params.slot, 20)
  h.page.onDestroy()
})

test('an old liked-page request cannot schedule thumbnails for a replacement page', async () => {
  const h = await createHarness('tracks')
  await h.reply(0, { success: true, total: 60, nextOffset: 30, items: [{ albumId: 'old', artUrl: 'old.jpg' }] })
  h.page.load(30)
  await h.reply(2, { success: true, total: 60, nextOffset: null, items: [{ albumId: 'new', artUrl: 'new.jpg' }] })
  await h.reply(1)
  assert.equal(h.page.state.items[0].albumId, 'new')
  assert.equal(h.page._thumbnailActive, 1)
  assert.equal(h.calls.length, 4)
  h.page.onDestroy()
})

test('liked-song artwork is reused on home and survives an app restart', async () => {
  const liked = await createHarness('tracks')
  liked.page.onReceivedFile({ readyState: 'transferred', filePath: 'liked-a.png', params: { kind: 'spotify-track-cover', albumId: 'album-a' } })
  liked.page.onDestroy()
  const home = await createHarness('home', undefined, liked.shared)
  assert.ok(home.calls[0].params.knownAlbums.includes('album-a'))
  await home.reply(0, playback(track('a', true)))
  assert.equal(home.page.artWidget.options.src, 'liked-a.png')
  assert.equal(home.calls.length, 1)
  home.page.onDestroy()
  const restarted = await createHarness('home', undefined, { ...liked.shared, globalData: {} })
  await restarted.reply(0, playback(track('a', true)))
  assert.equal(restarted.page.artWidget.options.src, 'liked-a.png')
  assert.equal(restarted.calls.length, 1)
  restarted.page.onDestroy()
})

test('missing cached files are fetched again after restart', async () => {
  const h = await createHarness()
  deliverCover(h.page, 'album-a', 'preview', 'gone.png')
  h.page.onDestroy()
  const restarted = await createHarness('home', undefined, { ...h.shared, globalData: {}, files: new Map() })
  assert.equal(restarted.calls[0].params.knownAlbums.includes('album-a'), false)
  await restarted.reply(0, playback(track('a', true)))
  assert.equal(restarted.calls[1].params.albumId, 'album-a')
  restarted.page.onDestroy()
})

test('an automatically started cover needs no second watch request; failure permits retry', async () => {
  const h = await createHarness()
  await h.reply(0, { ...playback(track('a', true)), art: { albumId: 'album-a', quality: 'preview' } })
  assert.equal(h.calls.length, 1)
  h.page.onCall({ method: 'spotify.artFailed', params: { albumId: 'album-a' } })
  h.page.requestCover(track('a', true))
  assert.equal(h.calls[1].params.url, 'a-64')
  h.page.onDestroy()
})

test('playlists load all pages and keep filters and rows when a later page needs retry', async () => {
  const h = await createHarness('playlists')
  const first = Array.from({ length: 50 }, (_, i) => ({ name: `Playlist ${i}`, uri: `spotify:playlist:${i}`, source: i % 2 ? 'mine' : 'other' }))
  await h.reply(0, { success: true, total: 75, nextOffset: 50, items: first })
  assert.equal(h.calls[1].params.offset, 50)
  h.page.setFilter('mine')
  const list = h.page.listWidget
  await h.reply(1, { success: false, error: 'Network failed' })
  assert.equal(h.page.state.items.length, 50)
  assert.equal(h.page.listWidget, list)
  assert.equal(h.page.state.visibleItems.length, 25)
  h.page.refreshWidget.options.click_func()
  assert.equal(h.calls[2].params.offset, 50)
  const last = Array.from({ length: 25 }, (_, i) => ({ name: `Playlist ${i + 50}`, uri: `spotify:playlist:${i + 50}`, source: 'mine' }))
  await h.reply(2, { success: true, total: 75, nextOffset: null, items: last })
  assert.equal(h.page.state.items.length, 75)
  assert.equal(h.page.state.visibleItems.length, 50)
  assert.equal(h.page.listWidget, list, 'appending a page updates the existing list')
  h.page.refreshWidget.options.click_func()
  assert.equal(h.calls[3].params.offset, 0)
  assert.equal(h.calls[3].params.refresh, true)
  h.page.onDestroy()
})

test('radio screen offers a labeled artist mix without silently starting it', async () => {
  const h = await createHarness('radio', { uri: 'spotify:track:seed', name: 'Seed' })
  assert.equal(h.calls.length, 0)
  h.page.start()
  assert.equal(h.calls[0].method, 'spotify.startRadio')
  await h.reply(0, { success: true, needsArtistMix: true })
  assert.equal(h.page.actionWidget.options.text, 'Play artist mix')
  assert.match(h.page.statusWidget.options.text, /Spotify radio is unavailable/)
  assert.equal(h.calls.length, 1)
  h.page.start()
  assert.equal(h.calls[1].method, 'spotify.startArtistMix')
  await h.reply(1, { success: true, mode: 'artist-mix', count: 10 })
  assert.match(h.page.statusWidget.options.text, /Artist mix playing · 10 songs/)
  h.page.onDestroy()
})

test('radio buttons target the selected liked/search song without first playing it', async () => {
  for (const pageName of ['tracks', 'search']) {
    const h = await createHarness(pageName)
    if (pageName === 'search') h.page.search('seed')
    await h.reply(0, { success: true, items: [{ name: 'Selected', uri: 'spotify:track:selected' }] })
    h.page.listWidget.options.item_click_func(h.page.listWidget, 0, 'radio')
    assert.equal(h.routes[0].url, 'page/gt/radio/index.page')
    assert.equal(h.routes[0].params.uri, 'spotify:track:selected')
    assert.equal(h.calls.length, 1)
    h.page.onDestroy()
  }
})
