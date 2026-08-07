import type { DfsPlayer } from './types'

export const NFL = {
  salaryCap: 50000,
  minSpend: 48000,
  slots: ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'DST']
}

export function eligibleForSlot(player: DfsPlayer, slot: string) {
  const positions = new Set(
    [player.position, ...(player.eligiblePositions || [])]
      .flatMap((x) => x.toUpperCase().replace('D/ST', 'DST').split(/[\/,]/))
      .map((x) => x.trim())
  )
  if (slot === 'FLEX') return ['RB', 'WR', 'TE'].some((p) => positions.has(p))
  if (slot === 'DST') return positions.has('DST') || positions.has('DEF')
  return positions.has(slot)
}
