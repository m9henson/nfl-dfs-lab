import type { DfsPlayer, Lineup } from './types'
import { NFL } from './sports'

export function parseCsv(text: string) {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"'
        i++
      } else {
        quoted = !quoted
      }
    } else if (ch === ',' && !quoted) {
      row.push(cell)
      cell = ''
    } else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      if (row.some((x) => x.trim())) rows.push(row)
      row = []
      cell = ''
    } else {
      cell += ch
    }
  }
  row.push(cell)
  if (row.some((x) => x.trim())) rows.push(row)
  return rows
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const find = (headers: string[], names: string[]) =>
  headers.findIndex((h) => names.map(norm).includes(norm(h)))

export function importDraftKingsCsv(text: string): DfsPlayer[] {
  const rows = parseCsv(text)
  if (rows.length < 2) return []

  let headerIndex = rows.findIndex((r) => {
    const n = r.map(norm)
    return n.includes('salary') && (n.includes('nameid') || n.includes('name') || n.includes('player'))
  })
  if (headerIndex < 0) headerIndex = 0

  const h = rows[headerIndex]
  const ix = {
    nameId: find(h, ['Name + ID', 'Name+ID', 'Name ID']),
    name: find(h, ['Name', 'Player', 'Player Name']),
    id: find(h, ['ID', 'Player ID']),
    position: find(h, ['Roster Position', 'Position', 'Pos']),
    salary: find(h, ['Salary']),
    team: find(h, ['TeamAbbrev', 'Team Abbrev', 'Team']),
    game: find(h, ['Game Info', 'Game']),
    fppg: find(h, ['AvgPointsPerGame', 'Avg Points Per Game', 'FPPG'])
  }

  return rows.slice(headerIndex + 1).flatMap((r) => {
    const nameId = ix.nameId >= 0 ? r[ix.nameId] || '' : ''
    const match = nameId.match(/^(.*?)\s*\((\d+)\)\s*$/)
    const name = (ix.name >= 0 ? r[ix.name] : match?.[1])?.trim()
    const id = (ix.id >= 0 ? r[ix.id] : match?.[2])?.trim() || name || ''
    const salary = Number(String(ix.salary >= 0 ? r[ix.salary] : '').replace(/[$,]/g, ''))
    const position = (ix.position >= 0 ? r[ix.position] : '').trim().toUpperCase()
    if (!name || !salary || !position) return []

    const fppg = Number(ix.fppg >= 0 ? r[ix.fppg] : 0) || 0
    const game = ix.game >= 0 ? r[ix.game] || '' : ''
    const team = ix.team >= 0 ? r[ix.team] || '' : ''

    return [{
      id,
      name,
      position,
      eligiblePositions: position.split('/'),
      salary,
      team,
      game,
      fppg,
      projection: fppg,
      ceiling: fppg * 1.28,
      ownership: 0
    }]
  })
}

function escapeCsv(value: unknown) {
  const s = String(value ?? '')
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

export function exportDraftKingsLineups(lineups: Lineup[]) {
  const slots = NFL.slots
  const lines = [slots.map(escapeCsv).join(',')]
  for (const lineup of lineups) {
    const cells = lineup.players.map((p) => escapeCsv(p.id ? `${p.name} (${p.id})` : p.name))
    lines.push(cells.join(','))
  }
  return lines.join('\n')
}
