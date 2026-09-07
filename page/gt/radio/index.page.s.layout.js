import * as hmUI from '@zos/ui'
import { getDeviceInfo } from '@zos/device'
import { px } from '@zos/utils'

const { width: W, height: H } = getDeviceInfo()
export const BG_STYLE = { x: 0, y: 0, w: W, h: H, color: 0x090909 }
export const TITLE_STYLE = {
  x: px(20), y: px(18), w: W - px(40), h: px(36), text: 'Song radio',
  color: 0x1ed760, text_size: px(24), align_h: hmUI.align.CENTER_H,
}
export const SONG_STYLE = {
  x: px(24), y: px(70), w: W - px(48), h: px(78),
  color: 0xffffff, text_size: px(21), text_style: hmUI.text_style.WRAP, align_h: hmUI.align.CENTER_H,
}
export const STATUS_STYLE = {
  x: px(26), y: px(155), w: W - px(52), h: H - px(260),
  text: 'Start with this song and Spotify recommendations. An artist mix is available if Spotify radio cannot be used.',
  color: 0xaaaaaa, text_size: px(17), text_style: hmUI.text_style.WRAP, align_h: hmUI.align.CENTER_H,
}
export const ACTION_STYLE = {
  x: px(28), y: H - px(82), w: W - px(56), h: px(52), text: 'Start radio',
  radius: px(16), normal_color: 0x1ed760, press_color: 0x169c46, color: 0x000000, text_size: px(20),
}
