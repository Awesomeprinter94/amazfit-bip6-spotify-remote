import { localStorage } from '@zos/storage'
import { statSync } from '@zos/fs'

const CACHE_KEY = 'spotify-artwork-v2'
const CACHE_LIMIT = 48

export function artworkParams(params) {
  if (params && typeof params === 'object') return params
  try { return JSON.parse(params || '{}') || {} } catch (error) { return {} }
}

function cache() {
  const data = getApp()._options.globalData
  if (!data.artworkCache) {
    let entries = []
    try { entries = JSON.parse(localStorage.getItem(CACHE_KEY) || '[]') } catch (error) {}
    data.artworkCache = Array.isArray(entries)
      ? entries.filter((entry) => entry && typeof entry.albumId === 'string' && typeof entry.path === 'string'
        && (entry.quality === 'preview' || entry.quality === 'full')).slice(-CACHE_LIMIT) : []
  }
  return data.artworkCache
}

function save(entries) {
  getApp()._options.globalData.artworkCache = entries
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(entries)) } catch (error) {}
}

function forgetPath(path) {
  const entries = cache()
  const next = entries.filter((entry) => entry.path !== path)
  if (next.length !== entries.length) save(next)
}

export function cachedArtwork(albumId, quality = '') {
  const entries = cache()
  const candidates = entries.filter((entry) => entry.albumId === albumId && (!quality || entry.quality === quality))
  candidates.sort((a, b) => Number(b.quality === 'full') - Number(a.quality === 'full'))
  for (let index = 0; index < candidates.length; index += 1) {
    const entry = candidates[index]
    try {
      const stat = statSync({ path: entry.path })
      if (stat && stat.size > 0) return entry
    } catch (error) {}
    forgetPath(entry.path)
  }
  return null
}

export function knownArtworkAlbums() {
  // Small enough to include with metadata requests, avoiding another round trip.
  return cache().filter((entry) => {
    try { const stat = statSync({ path: entry.path }); return stat && stat.size > 0 } catch (error) { return false }
  }).map((entry) => entry.albumId)
    .filter((id, index, ids) => ids.indexOf(id) === index)
}

export function observeArtwork(file, onReady) {
  if (!file) return
  const params = artworkParams(file.params)
  if (!params.albumId || (params.kind !== 'spotify-cover' && params.kind !== 'spotify-track-cover')) return
  let applied = false
  const apply = () => {
    if (applied || !file.filePath) return
    applied = true
    const quality = params.kind === 'spotify-track-cover' || params.quality === 'preview' ? 'preview' : 'full'
    const entries = cache()
    if (!entries.some((entry) => entry.path === file.filePath && entry.albumId === params.albumId && entry.quality === quality)) {
      const next = entries.filter((entry) => entry.path !== file.filePath && !(entry.albumId === params.albumId && entry.quality === quality))
      next.push({ albumId: params.albumId, quality, path: file.filePath })
      save(next.slice(-CACHE_LIMIT))
    }
    if (onReady) onReady({ albumId: params.albumId, quality, path: file.filePath })
  }
  try {
    if (file.readyState === 'transferred') apply()
    else {
      // A canceled transfer may have partly overwritten the previous file.
      if (file.filePath) forgetPath(file.filePath)
      file.on('change', (event) => {
        if (event && event.data && event.data.readyState === 'transferred') apply()
      })
    }
  } catch (error) {}
}
