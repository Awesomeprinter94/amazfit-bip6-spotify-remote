import * as hmUI from '@zos/ui'
import { back } from '@zos/router'
import { BasePage } from '@zeppos/zml/base-page'
import { cachedArtwork, observeArtwork } from '../../../utils/artwork'
import { BG_STYLE, COVER_STYLE, HINT_STYLE } from 'zosLoader:./index.page.[pf].layout.js'

function parseParams(params) {
  if (params && typeof params === 'object') return params
  if (typeof params !== 'string' || !params) return {}
  try {
    return JSON.parse(params) || {}
  } catch (error) {
    return {}
  }
}

Page(BasePage({
  state: { coverPath: 'image/art_placeholder.png' },

  onInit(params) {
    const data = parseParams(params)
    this.state.coverPath = data.src || 'image/art_placeholder.png'
    this.state.albumId = data.albumId || ''
    this.state.url = data.url || ''
    this.state.quality = data.quality || ''
    this.state.alive = true
    this._coverRequest = null
    this._generation = Number(this._generation || 0) + 1
    const cached = cachedArtwork(this.state.albumId)
    if (cached) {
      this.state.coverPath = cached.path
      this.state.quality = cached.quality
    }
  },

  build() {
    if (typeof hmUI.setStatusBarVisible === 'function') hmUI.setStatusBarVisible(false)
    const close = () => back()
    const background = hmUI.createWidget(hmUI.widget.FILL_RECT, BG_STYLE)
    background.addEventListener(hmUI.event.CLICK_DOWN, close)

    const cover = this.coverWidget = hmUI.createWidget(hmUI.widget.IMG, {
      ...COVER_STYLE,
      src: this.state.coverPath,
    })
    cover.addEventListener(hmUI.event.CLICK_DOWN, close)

    const hint = hmUI.createWidget(hmUI.widget.TEXT, HINT_STYLE)
    hint.setEnable(false)
    if (this.state.quality !== 'full') this.requestFullCover()
  },

  requestFullCover() {
    if (!this.state.url || !this.state.albumId || typeof this.request !== 'function' || this._coverRequest) return
    this._coverRequest = this.request({
      method: 'spotify.getArt',
      params: { url: this.state.url, albumId: this.state.albumId, quality: 'full' },
    }).catch(() => {}).finally(() => { this._coverRequest = null })
  },

  onReceivedFile(file) {
    const generation = this._generation
    observeArtwork(file, (entry) => {
      if (!this.state.alive || generation !== this._generation || !this.coverWidget) return
      if (entry.albumId !== this.state.albumId) {
        if (entry.path === this.state.coverPath) {
          this.state.coverPath = 'image/art_placeholder.png'
          this.coverWidget.setProperty(hmUI.prop.SRC, this.state.coverPath)
          this.requestFullCover()
        }
        return
      }
      if (entry.quality === 'preview') return
      this.state.coverPath = entry.path
      this.coverWidget.setProperty(hmUI.prop.MORE, { ...COVER_STYLE, src: entry.path })
    })
  },

  onDestroy() {
    this.state.alive = false
    this._generation = Number(this._generation || 0) + 1
  },
}))
