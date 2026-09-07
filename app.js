import { BaseApp } from '@zeppos/zml/base-app'
import { observeArtwork } from './utils/artwork'

App(
  BaseApp({
    globalData: {},
    onCreate(options) {
      console.log('Spotify app onCreate')
    },
    onReceivedFile(file) {
      observeArtwork(file)
    },
    onDestroy(options) {
      console.log('Spotify app onDestroy')
    },
  }),
)
