import type { Config } from 'vike/types'
import vikeReact from 'vike-react/config'

export default {
  extends: [vikeReact],
  ssr: false,
  title: 'NFL DFS Lab',
  description: 'NFL DraftKings research and lineup optimizer'
} satisfies Config
