import * as hmUI from '@zos/ui'
import { BasePage } from '@zeppos/zml/base-page'
import { BG_STYLE, TITLE_STYLE, SONG_STYLE, STATUS_STYLE, ACTION_STYLE } from 'zosLoader:./index.page.[pf].layout.js'

Page(BasePage({
  state: { alive: false, busy: false },

  onInit(params) {
    let data = params || {}
    if (typeof data === 'string') {
      try { data = JSON.parse(data) || {} } catch (error) { data = {} }
    }
    this.state.alive = true
    this.state.busy = false
    this.state.uri = String(data.uri || '')
    this.state.name = String(data.name || 'Selected song')
    this.state.artistMix = false
    this._generation = Number(this._generation || 0) + 1
  },

  build() {
    if (typeof hmUI.setStatusBarVisible === 'function') hmUI.setStatusBarVisible(false)
    hmUI.createWidget(hmUI.widget.FILL_RECT, BG_STYLE)
    hmUI.createWidget(hmUI.widget.TEXT, TITLE_STYLE)
    hmUI.createWidget(hmUI.widget.TEXT, { ...SONG_STYLE, text: this.state.name })
    this.statusWidget = hmUI.createWidget(hmUI.widget.TEXT, STATUS_STYLE)
    this.actionWidget = hmUI.createWidget(hmUI.widget.BUTTON, { ...ACTION_STYLE, click_func: () => this.start() })
  },

  start() {
    if (!this.state.alive || this.state.busy) return
    this.state.busy = true
    const generation = this._generation
    this.statusWidget.setProperty(hmUI.prop.TEXT, this.state.artistMix ? 'Finding songs by this song’s artists…' : 'Finding song recommendations…')
    this.request({ method: this.state.artistMix ? 'spotify.startArtistMix' : 'spotify.startRadio', params: { uri: this.state.uri } })
      .then((response) => {
        if (!this.state.alive || generation !== this._generation) return
        this.state.busy = false
        if (!response || response.success === false) throw new Error((response && response.error) || 'Could not start playback')
        if (response.needsArtistMix) {
          this.state.artistMix = true
          this.statusWidget.setProperty(hmUI.prop.TEXT, 'Spotify radio is unavailable for this app. You can play a mix of songs by the selected song’s artists instead.')
          this.actionWidget.setProperty(hmUI.prop.MORE, { ...ACTION_STYLE, text: 'Play artist mix' })
          return
        }
        this.statusWidget.setProperty(hmUI.prop.TEXT, `${response.mode === 'artist-mix' ? 'Artist mix' : 'Song recommendations'} playing · ${response.count} songs.\n\nSwipe right to return.`)
        this.actionWidget.setProperty(hmUI.prop.VISIBLE, false)
      })
      .catch((error) => {
        if (!this.state.alive || generation !== this._generation) return
        this.state.busy = false
        this.statusWidget.setProperty(hmUI.prop.TEXT, String(error.message || error))
      })
  },

  onDestroy() {
    this.state.alive = false
    this._generation += 1
  },
}))
