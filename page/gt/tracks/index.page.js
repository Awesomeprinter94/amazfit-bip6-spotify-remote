import * as hmUI from '@zos/ui'
import { px } from '@zos/utils'
import { back, push } from '@zos/router'
import { BasePage } from '@zeppos/zml/base-page'
import { cachedArtwork, observeArtwork } from '../../../utils/artwork'
import {
  BG_STYLE,
  ERROR_STYLE,
  HEADER_STYLE,
  LIST_STYLE,
  STATUS_STYLE,
  PREVIOUS_PAGE_STYLE,
  NEXT_PAGE_STYLE,
} from 'zosLoader:./index.page.[pf].layout.js'

const PLACEHOLDER = 'image/art_placeholder.png'

Page(
  BasePage({
    state: { alive: false, busy: false, items: [] },

    onInit() {
      this.state.alive = true
      this.state.busy = false
      this.state.items = []
      this._generation = Number(this._generation || 0) + 1
      this._active = true
      this._loadSequence = 0
      this._offset = 0
      this._nextOffset = null
      this._total = 0
      this._loading = false
      this._thumbnailActive = 0
      this._thumbnailPending = {}
      this._thumbnailAttempts = {}
      this._thumbnailDone = {}
      this._focus = 0
      this.listWidget = null
    },

    build() {
      if (typeof hmUI.setStatusBarVisible === 'function') hmUI.setStatusBarVisible(false)
      hmUI.createWidget(hmUI.widget.FILL_RECT, BG_STYLE)
      hmUI.createWidget(hmUI.widget.TEXT, HEADER_STYLE)
      this.statusWidget = hmUI.createWidget(hmUI.widget.TEXT, {
        ...STATUS_STYLE,
        text: 'Loading liked songs...',
      })
      this.statusWidget.addEventListener(hmUI.event.CLICK_DOWN, () => this.retryImages())
      this.previousPageWidget = hmUI.createWidget(hmUI.widget.BUTTON, {
        ...PREVIOUS_PAGE_STYLE,
        click_func: () => { if (this._offset > 0) this.load(Math.max(0, this._offset - 30)) },
      })
      this.nextPageWidget = hmUI.createWidget(hmUI.widget.BUTTON, {
        ...NEXT_PAGE_STYLE,
        click_func: () => {
          if (this._loadError) this.load(this._failedOffset)
          else if (this._nextOffset !== null) this.load(this._nextOffset)
        },
      })

      if (typeof this.request !== 'function') {
        this.setStatus('Phone bridge unavailable', true)
        return
      }
      this.load()
    },

    setStatus(text, isError) {
      if (!this.state.alive || !this.statusWidget) return
      const error = !!isError
      this.statusWidget.setProperty(hmUI.prop.MORE, {
        ...(error ? ERROR_STYLE : STATUS_STYLE),
        text: error
          ? `Liked Songs error\n\n${String(text || 'Unknown error')}\n\nSwipe right to go back.`
          : String(text || ''),
        color: error ? 0xff5c5c : 0x1ed760,
      })
      if (this.listWidget) this.listWidget.setProperty(hmUI.prop.VISIBLE, !error)
    },

    onReceivedFile(file) {
      const generation = this._generation
      observeArtwork(file, (entry) => {
        if (!this.state.alive || generation !== this._generation || entry.quality !== 'preview') return
        this.state.items.forEach((item, index) => {
          if (item.coverPath === entry.path && item.albumId !== entry.albumId) {
            item.coverPath = PLACEHOLDER
            delete this._thumbnailDone[item.albumId]
            delete this._thumbnailAttempts[item.albumId]
            this.updateListItem(index)
          }
          if (item.albumId === entry.albumId) {
            item.coverPath = entry.path
            this._thumbnailDone[item.albumId] = true
            this.updateListItem(index)
          }
        })
        this.updateImageStatus()
      })
    },

    load(offset = 0) {
      if (!this.state.alive || this.state.busy || this._loading) return
      const generation = this._generation
      const sequence = ++this._loadSequence
      this._loading = true
      this._loadError = false
      this._thumbnailActive = 0
      this._thumbnailPending = {}
      this.setStatus('Loading liked songs…', false)
      this.request({ method: 'spotify.getTracks', params: { offset } })
        .then((response) => {
          if (!this.state.alive || generation !== this._generation || sequence !== this._loadSequence) return
          this._loading = false
          if (!response || response.success === false) {
            throw new Error((response && response.error) || 'Could not load songs')
          }
          const items = (response.items || []).map((item) => ({
            ...item,
            coverPath: (cachedArtwork(item.albumId, 'preview') || {}).path || PLACEHOLDER,
          }))
          this._offset = offset
          this._nextOffset = response.nextOffset === undefined ? null : response.nextOffset
          this._total = response.total || items.length
          this._thumbnailActive = 0
          this._thumbnailPending = {}
          this._thumbnailAttempts = {}
          this._thumbnailDone = {}
          this._focus = 0
          this.state.items = items
          this.previousPageWidget.setProperty(hmUI.prop.MORE, { ...PREVIOUS_PAGE_STYLE, text: offset ? 'Previous' : 'First page' })
          this.nextPageWidget.setProperty(hmUI.prop.MORE, { ...NEXT_PAGE_STYLE, text: this._nextOffset === null ? 'Last page' : 'Next songs' })
          this.renderList(items)
          this.updateImageStatus()
          this.pumpThumbnails()
        })
        .catch((error) => {
          if (!this.state.alive || generation !== this._generation || sequence !== this._loadSequence) return
          this._loading = false
          this._loadError = true
          this._failedOffset = offset
          this.setStatus(error.message || error, false)
          this.nextPageWidget.setProperty(hmUI.prop.MORE, { ...NEXT_PAGE_STYLE, text: 'Retry loading' })
        })
    },

    listItem(item) {
      return {
        cover: item.coverPath || PLACEHOLDER,
        name: String(item.name || 'Unknown track').substring(0, 36),
        subtitle: String(item.subtitle || 'Unknown artist').substring(0, 40),
        radio: 'Radio',
      }
    },

    updateListItem(index) {
      if (!this.listWidget || !this.state.items[index]) return
      try {
        this.listWidget.setProperty(hmUI.prop.UPDATE_ITEM, {
          index,
          item_data: this.listItem(this.state.items[index]),
        })
      } catch (error) {}
    },

    updateImageStatus() {
      if (this.state.busy || this._loading || this._loadError) return
      const items = this.state.items
      if (!items.length) { this.setStatus('No liked songs found', false); return }
      const withArt = items.filter((item) => item.artUrl)
      const loaded = withArt.filter((item) => item.coverPath !== PLACEHOLDER).length
      this.setStatus(`${this._offset + 1}–${this._offset + items.length}/${this._total} · ${loaded}/${withArt.length} covers${loaded < withArt.length ? ' · Tap to retry' : ''}`, false)
    },

    retryImages() {
      if (this.state.busy || this._loading) return
      this._thumbnailAttempts = {}
      this._thumbnailDone = {}
      this.pumpThumbnails()
    },

    pumpThumbnails() {
      if (!this.state.alive || !this._active || this.state.busy || this._loading) return
      const sequence = this._loadSequence
      const order = this.state.items.map((item, index) => index).sort((a, b) => Math.abs(a - this._focus) - Math.abs(b - this._focus))
      while (this._thumbnailActive < 2) {
        const index = order.find((i) => {
          const item = this.state.items[i]
          return item.albumId && item.artUrl && item.coverPath === PLACEHOLDER && !this._thumbnailPending[item.albumId]
            && !this._thumbnailDone[item.albumId] && (this._thumbnailAttempts[item.albumId] || 0) < 2
        })
        if (index === undefined) break
        const item = this.state.items[index]
        const cached = cachedArtwork(item.albumId, 'preview')
        if (cached) {
          this.state.items.forEach((candidate, row) => {
            if (candidate.albumId === item.albumId) { candidate.coverPath = cached.path; this.updateListItem(row) }
          })
          continue
        }
        this._thumbnailActive += 1
        this._thumbnailPending[item.albumId] = true
        this._thumbnailAttempts[item.albumId] = (this._thumbnailAttempts[item.albumId] || 0) + 1
        this.request({ method: 'spotify.getTrackArt', params: { url: item.artUrl, albumId: item.albumId, slot: index } })
          .then((response) => {
            if (sequence === this._loadSequence && response && response.success !== false && response.transferred !== false) this._thumbnailDone[item.albumId] = true
          }).catch(() => {}).finally(() => {
            if (!this.state.alive || sequence !== this._loadSequence) return
            this._thumbnailActive -= 1
            delete this._thumbnailPending[item.albumId]
            this.updateImageStatus()
            this.pumpThumbnails()
          })
      }
    },

    renderList(items) {
      if (this.listWidget) hmUI.deleteWidget(this.listWidget)
      this.listWidget = null
      if (!items.length) return
      const data = items.map((item) => this.listItem(item))

      this.listWidget = hmUI.createWidget(hmUI.widget.SCROLL_LIST, {
        ...LIST_STYLE,
        item_space: px(7),
        item_config: [{
          type_id: 1,
          item_bg_color: 0x191919,
          item_bg_radius: px(12),
          item_height: px(70),
          text_view: [
            {
              x: px(70),
              y: px(7),
              w: LIST_STYLE.w - px(156),
              h: px(29),
              key: 'name',
              color: 0xffffff,
              text_size: px(18),
              action: true,
            },
            {
              x: px(70),
              y: px(38),
              w: LIST_STYLE.w - px(156),
              h: px(22),
              key: 'subtitle',
              color: 0x8f8f8f,
              text_size: px(13),
              action: true,
            },
            { x: LIST_STYLE.w - px(74), y: px(15), w: px(66), h: px(40), key: 'radio', color: 0x1ed760, text_size: px(16), action: true },
          ],
          text_view_count: 3,
          image_view: [{
            x: px(8),
            y: px(8),
            w: px(54),
            h: px(54),
            key: 'cover',
            action: true,
          }],
          image_view_count: 1,
        }],
        item_config_count: 1,
        data_array: data,
        data_count: data.length,
        data_type_config: [{ start: 0, end: data.length - 1, type_id: 1 }],
        data_type_config_count: 1,
        enable_scroll_bar: true,
        item_focus_change_func: (list, index, focus) => {
          if (focus) { this._focus = index; this.pumpThumbnails() }
        },
        item_click_func: (list, index, key) => {
          const item = this.state.items[index]
          if (key === 'radio' && item && !this.state.busy) push({ url: 'page/gt/radio/index.page', params: { uri: item.uri, name: item.name } })
          else if (key !== 'radio') this.playTrack(index)
        },
      })
    },

    playTrack(index) {
      if (this.state.busy || !this.state.alive) return
      const item = this.state.items[index]
      if (!item) return
      const generation = this._generation
      this.state.busy = true
      this.setStatus(`Playing ${String(item.name).substring(0, 22)}...`, false)

      this.request({ method: 'spotify.playTrack', params: { uri: item.uri } })
        .then((response) => {
          if (!this.state.alive || generation !== this._generation) return
          if (!response || response.success === false) {
            this.state.busy = false
            this.setStatus((response && response.error) || 'Could not play song', true)
            this.pumpThumbnails()
            return
          }
          back()
        })
        .catch((error) => {
          if (!this.state.alive || generation !== this._generation) return
          this.state.busy = false
          this.setStatus(error.message || error, true)
          this.pumpThumbnails()
        })
    },

    onPause() { this._active = false },

    onResume() { this._active = true; this.retryImages() },

    onDestroy() {
      this.state.alive = false
      this._loadSequence += 1
      this._generation = Number(this._generation || 0) + 1
    },
  }),
)
