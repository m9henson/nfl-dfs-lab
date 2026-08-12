export type DfsPlayer = {
  id: string
  name: string
  position: string
  eligiblePositions: string[]
  salary: number
  team: string
  opponent?: string
  game?: string
  fppg: number
  projection: number
  ceiling: number
  ownership: number
  status?: string
  locked?: boolean
  excluded?: boolean

  targets?: number
  carries?: number
  receptions?: number
  routes?: number
  snaps?: number
  redZoneTouches?: number
  insideTenTouches?: number
  insideFiveTouches?: number
  redZoneTargets?: number
  redZoneCarries?: number
  depthChartOrder?: number
  injuryStatus?: string
  practiceParticipation?: string
  trendingAdds?: number
  weatherTempF?: number
  weatherWindMph?: number
  weatherGustMph?: number
  weatherPrecipProb?: number
  weatherScore?: number
  targetShare?: number
  airYardsShare?: number
  wopr?: number
  rushShare?: number
  teamImplied?: number
  gameTotal?: number
  spread?: number
  defenseVsPositionRank?: number

  opportunityScore?: number
  matchupScore?: number
  vegasScore?: number
  valueScore?: number
  ceilingScore?: number
  leverageScore?: number
  dfsScore?: number

  externalProjection?: number
  externalValue?: number
  externalSource?: string
  externalUpdatedAt?: string
}

export type LineupPlayer = DfsPlayer & { assignedSlot: string }

export type Lineup = {
  players: LineupPlayer[]
  salary: number
  projection: number
  ceiling: number
}

export type Slate = {
  draftGroupId: string
  name: string
  startTime?: string
  contestCount: number
  entryFees: number[]
}
