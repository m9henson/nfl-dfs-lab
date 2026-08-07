# NFL DFS Lab

NFL-only Vike + React + TypeScript DraftKings research and lineup generator.

## Weekly workflow

1. Find a DraftKings NFL slate or import the official DK CSV.
2. Load nflverse weekly history/usage.
3. Load Win With Odds public projections if desired.
4. Review each player's:
   - Opportunity Score
   - Matchup Score
   - Vegas Score
   - Value Score
   - Ceiling Score
   - Leverage Score
   - Overall DFS Score
5. Edit projections or ownership.
6. Lock/exclude players.
7. Generate NFL Classic lineups.
8. Export a DraftKings CSV.

## NFL-only roster

QB, RB, RB, WR, WR, WR, TE, FLEX, DST

## Current automatic sources

### DraftKings
Public-facing slate/draftable adapter with official CSV fallback. The endpoints are undocumented and can change.

### nflverse
Previous-week player summary data for targets, carries, receptions, target share, air-yards share, WOPR and PPR fantasy history where available.

### Win With Odds
Optional public football DFS projection/value import.

## Planned data connectors

The scoring model is ready for:
- defense vs position
- team implied totals and spreads
- game totals
- red-zone and inside-five touches
- routes and snaps
- projected ownership
- weather
- pressure/sack metrics

Use licensed or permitted sources for commercial deployment.

## Run

```bash
npm install
npm run dev
```

## Deploy

This needs a Node server; GitHub Pages alone is not sufficient. `render.yaml` and `Dockerfile` are included.

## v7 matchup rating update
- Dashboard remains Top 3 by QB/RB/WR/TE/DST.
- Player Rating now combines Projection (22%), Usage (18%), DVP (14%), Vegas (10%), Recent Form (12%), Value (10%), Ceiling (10%), and WR/CB matchup proxy (4%).
- nflverse Week 1 automatically uses the prior regular season's last 8 weeks instead of requesting a not-yet-published current-season file.
- DVP is calculated from fantasy points allowed by opponent and position across the loaded historical window. Rank #1 means the defense allowed the most fantasy production to that position (easiest matchup).
- WR/CB currently uses team WR coverage/DVP as a proxy; it is labeled as a proxy until a reliable individual shadow-coverage feed is connected.
