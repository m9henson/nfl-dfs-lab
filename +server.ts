import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import vike from '@vikejs/hono'
import type { Server } from 'vike/types'
import OpenAI from 'openai'
import * as cheerio from 'cheerio'

const app = new Hono()

// Production Vike/Vite browser assets.
// Render runs the server from the repository root, while Vike emits
// hashed CSS/JS into dist/client/assets.
app.use('/assets/*', serveStatic({ root: './dist/client' }))
app.use('/favicon.ico', serveStatic({ root: './dist/client' }))
app.use('/manifest.webmanifest', serveStatic({ root: './dist/client' }))
const cache = new Map<string, { expires: number; value: unknown }>()

app.onError((err, c) => {
  console.error('Unhandled server error:', err)
  return c.json({ error: 'Internal server error', detail: err.message }, 500)
})


function cached<T>(key: string): T | undefined {
  const hit = cache.get(key)
  if (!hit) return undefined
  if (Date.now() > hit.expires) {
    cache.delete(key)
    return undefined
  }
  return hit.value as T
}

function store(key: string, value: unknown, ttlMs: number) {
  cache.set(key, { expires: Date.now() + ttlMs, value })
}

async function fetchJson(url: string) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 9000)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'accept': 'application/json,text/plain,*/*',
        'user-agent': 'UltimateDFS/1.0 (+server-side slate reader)'
      }
    })
    if (!res.ok) throw new Error(`Upstream returned ${res.status}`)
    return await res.json() as any
  } finally {
    clearTimeout(timeout)
  }
}

function safeNumber(value: unknown) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function first<T>(...values: T[]) {
  return values.find((v) => v !== undefined && v !== null && v !== '') as T | undefined
}

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    draftKingsMode: 'unofficial-public-endpoints-with-csv-fallback'
  })
)

app.get('/api/dk/slates', async (c) => {
  const sport = 'NFL'
  const key = 'slates:NFL'
  const hit = cached<any>(key)
  if (hit) return c.json(hit)

  try {
    // DraftKings doesn't publish these as a supported developer API. Keep this
    // behind the server adapter so a future endpoint change is isolated here.
    const raw = await fetchJson(
      `https://www.draftkings.com/lobby/getcontests?sport=${encodeURIComponent(sport)}`
    )
    const contests: any[] = raw?.Contests || raw?.contests || []
    const groups = new Map<string, any>()

    for (const contest of contests) {
      const dg = String(first(contest?.dg, contest?.draftGroupId, contest?.draftGroup?.id) || '')
      if (!/^\d+$/.test(dg)) continue
      const existing = groups.get(dg) || {
        draftGroupId: dg,
        name: first(contest?.n, contest?.name, contest?.contestName, contest?.dn) || `Draft Group ${dg}`,
        startTime: first(contest?.sd, contest?.startDate, contest?.startTime),
        contestCount: 0,
        entryFees: [] as number[]
      }
      existing.contestCount += 1
      const fee = safeNumber(first(contest?.a, contest?.entryFee, contest?.entryFeeAmount))
      if (fee && !existing.entryFees.includes(fee)) existing.entryFees.push(fee)
      groups.set(dg, existing)
    }

    const payload = {
      sport,
      source: 'DraftKings public-facing lobby endpoint (unofficial)',
      slates: [...groups.values()].sort((a, b) =>
        String(a.startTime || '').localeCompare(String(b.startTime || ''))
      )
    }
    store(key, payload, 60_000)
    c.header('Cache-Control', 'public, max-age=30')
    return c.json(payload)
  } catch (error) {
    return c.json({
      error: 'DraftKings slate fetch failed',
      detail: error instanceof Error ? error.message : String(error),
      fallback: 'Use the DraftKings CSV import in the app.'
    }, 502)
  }
})

app.get('/api/dk/draftables', async (c) => {
  const draftGroupId = c.req.query('draftGroupId') || ''
  if (!/^\d+$/.test(draftGroupId)) return c.json({ error: 'Invalid draftGroupId' }, 400)

  const key = `draftables:${draftGroupId}`
  const hit = cached<any>(key)
  if (hit) return c.json(hit)

  try {
    const raw = await fetchJson(
      `https://api.draftkings.com/draftgroups/v1/draftgroups/${draftGroupId}/draftables`
    )
    const draftables: any[] = raw?.draftables || raw?.Draftables || []

    const players = draftables.map((p) => {
      const attrs: any[] = p?.draftStatAttributes || p?.draftStatAttribute || []
      const fppgAttr = attrs.find((a) =>
        /fppg|avg.*points|fantasy.*points/i.test(String(first(a?.name, a?.label, a?.displayName) || ''))
      )
      const position = String(first(p?.position, p?.rosterPosition, p?.positionName) || '')
      const rosterSlots = (p?.rosterSlots || p?.rosterSlotNames || [])
        .map((x: any) => typeof x === 'string' ? x : first(x?.name, x?.displayName, x?.position))
        .filter(Boolean)

      return {
        id: String(first(p?.draftableId, p?.id, p?.playerId) || ''),
        playerId: String(first(p?.playerId, p?.draftableId, p?.id) || ''),
        name: String(first(p?.displayName, p?.name, p?.playerName) || ''),
        position,
        eligiblePositions: rosterSlots.length ? rosterSlots : position.split('/'),
        salary: safeNumber(p?.salary),
        team: String(first(p?.teamAbbreviation, p?.team, p?.teamName) || ''),
        opponent: String(first(p?.opponentTeamAbbreviation, p?.opponentTeam, p?.opponent) || ''),
        game: String(first(
          p?.competition?.name,
          p?.competitionName,
          p?.gameDescription,
          p?.gameInfo
        ) || ''),
        fppg: safeNumber(first(
          p?.fppg,
          p?.avgPointsPerGame,
          p?.averagePointsPerGame,
          fppgAttr?.value
        )),
        status: String(first(p?.status, p?.playerStatus) || '')
      }
    }).filter((p) => p.id && p.name && p.salary)

    const payload = {
      draftGroupId,
      source: 'DraftKings public-facing draftables endpoint (unofficial)',
      players
    }
    store(key, payload, 5 * 60_000)
    c.header('Cache-Control', 'public, max-age=120')
    return c.json(payload)
  } catch (error) {
    return c.json({
      error: 'DraftKings player-pool fetch failed',
      detail: error instanceof Error ? error.message : String(error),
      fallback: 'Use the DraftKings CSV import in the app.'
    }, 502)
  }
})

app.post('/api/ai/explain', async (c) => {
  if (!process.env.OPENAI_API_KEY) {
    return c.json({
      error: 'OPENAI_API_KEY is not configured on the server.',
      optional: true
    }, 503)
  }

  const body = await c.req.json().catch(() => null) as any
  if (!body?.sport || !Array.isArray(body?.players)) {
    return c.json({ error: 'sport and players are required' }, 400)
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
    reasoning: { effort: 'low' },
    input: [
      {
        role: 'system',
        content:
          'You are a concise DFS lineup analyst. Explain the lineup construction from the supplied projections, salaries and teams. Do not claim certainty or guarantee winnings. Mention the strongest correlation/value and the main risk in 3-5 short bullets.'
      },
      {
        role: 'user',
        content: JSON.stringify({
          sport: 'NFL',
          lineup: body.players
        })
      }
    ]
  })

  return c.json({ explanation: response.output_text })
})


app.get('/api/values/football', async (c) => {
  const key = 'football-values:winwithodds'
  const hit = cached<any>(key)
  if (hit) return c.json(hit)

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 9000)
    let html = ''
    try {
      const res = await fetch('https://www.winwithodds.com/dfs', {
        signal: controller.signal,
        headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'UltimateDFS/1.0 (+server-side value importer)' }
      })
      if (!res.ok) throw new Error(`Upstream returned ${res.status}`)
      html = await res.text()
    } finally { clearTimeout(timeout) }

    const $ = cheerio.load(html)
    const bodyText = $('body').text().replace(/\s+/g, ' ')
    const updatedMatch = bodyText.match(/Updated\s+([0-9/]+\s+[0-9:]+\s+[AP]M\s+ET)/i)
    const updatedAt = updatedMatch?.[1] || ''
    const values: Array<{ rank:number; name:string; position:string; salary:number; projection:number; value:number }> = []

    $('table tr').each((_, tr) => {
      const cells = $(tr).find('th,td').map((__, td) => $(td).text().trim()).get()
      if (cells.length < 6 || /player name/i.test(cells.join(' '))) return
      const rank = Number(cells[0])
      const salary = Number(cells[3].replace(/[$,]/g, ''))
      const projection = Number(cells[4])
      const value = Number(cells[5])
      if (!cells[1] || !cells[2] || !Number.isFinite(projection)) return
      values.push({ rank:Number.isFinite(rank)?rank:values.length+1, name:cells[1], position:cells[2].toUpperCase(), salary:Number.isFinite(salary)?salary:0, projection, value:Number.isFinite(value)?value:0 })
    })

    if (!values.length) throw new Error('No DFS value rows were found')
    const payload = { source:'Win With Odds DFS Values', sourceUrl:'https://www.winwithodds.com/dfs', updatedAt, fetchedAt:new Date().toISOString(), values }
    store(key, payload, 15 * 60_000)
    c.header('Cache-Control', 'public, max-age=300')
    return c.json(payload)
  } catch (error) {
    return c.json({ error:'Win With Odds football-value fetch failed', detail:error instanceof Error?error.message:String(error) }, 502)
  }
})


app.get('/api/nfl/weekly-stats', async (c) => {
  const season = Number(c.req.query('season') || new Date().getFullYear())
  const targetWeek = Number(c.req.query('week') || 1)
  const history = Math.max(3, Math.min(10, Number(c.req.query('history') || 8)))
  if (!Number.isInteger(season) || !Number.isInteger(targetWeek)) return c.json({ error: 'Invalid season/week' }, 400)

  const key = `nflverse:${season}:${targetWeek}:${history}:fallback-v2`
  const hit = cached<any>(key)
  if (hit) return c.json(hit)

  try {
    // In August/early season the requested season's weekly-stat asset may not exist yet.
    // Try the selected season first, then automatically fall back to the prior season
    // so Week 1 still has useful historical usage, recent-form and DVP data.
    let dataSeason=season, text='', sourceUrl=''
    const attempts:number[]=[]
    const candidateYears=targetWeek===1?[season-1,season-2]:[season,season-1,season-2]
    for(const y of candidateYears){
      attempts.push(y)
      const url=`https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${y}.csv`
      const res=await fetch(url,{headers:{'accept':'text/csv,*/*','user-agent':'NFLDFSLab/1.1'}})
      if(res.ok){dataSeason=y;text=await res.text();sourceUrl=url;break}
      if(res.status!==404) throw new Error(`nflverse returned ${res.status} for ${y}`)
    }
    if(!text) throw new Error(`No nflverse weekly player CSV found for ${attempts.join(', ')}`)

    const lines=text.replace(/\r/g,'').split('\n').filter(Boolean)
    const headers=lines[0].split(',').map(x=>x.replace(/^"|"$/g,''))
    const ix=(names:string[])=>names.map(n=>headers.indexOf(n)).find(i=>i>=0)??-1
    const col={
      week:ix(['week']),name:ix(['player_display_name','player_name']),pos:ix(['position','position_group']),
      team:ix(['recent_team','team']),opp:ix(['opponent_team','opponent']),targets:ix(['targets']),
      carries:ix(['carries','rushing_attempts']),receptions:ix(['receptions']),fantasy:ix(['fantasy_points_ppr','fantasy_points']),
      targetShare:ix(['target_share','tgt_sh']),airShare:ix(['air_yards_share','ay_sh']),wopr:ix(['wopr']),seasonType:ix(['season_type'])
    }
    if(col.week<0||col.name<0||col.pos<0||col.fantasy<0) throw new Error('nflverse CSV schema did not contain required weekly-player columns')
    const parsed=lines.slice(1).map(line=>line.split(',').map(x=>x.replace(/^"|"$/g,''))).map(r=>({
      week:Number(r[col.week]),name:r[col.name]||'',position:r[col.pos]||'',team:col.team>=0?r[col.team]||'':'',opponent:col.opp>=0?r[col.opp]||'':'',seasonType:col.seasonType>=0?r[col.seasonType]||'':'',
      targets:col.targets>=0?Number(r[col.targets]||0):0,carries:col.carries>=0?Number(r[col.carries]||0):0,receptions:col.receptions>=0?Number(r[col.receptions]||0):0,
      fantasyPoints:Number(r[col.fantasy]||0),targetShare:col.targetShare>=0?Number(r[col.targetShare]||0):0,airYardsShare:col.airShare>=0?Number(r[col.airShare]||0):0,wopr:col.wopr>=0?Number(r[col.wopr]||0):0
    })).filter(r=>Number.isFinite(r.week)&&r.name)
    // Player-summary files can contain postseason rows. Keep REG rows when that column exists.
    const regular=col.seasonType>=0?parsed.filter((r:any)=>!r.seasonType||r.seasonType==='REG'):parsed

    let rows:any[]
    if(dataSeason===season && targetWeek>1){
      const minWeek=Math.max(1,targetWeek-history)
      rows=regular.filter(r=>r.week>=minWeek&&r.week<targetWeek)
    }else{
      const weeks=[...new Set(regular.map(r=>r.week))].sort((a,b)=>b-a).slice(0,history)
      const keep=new Set(weeks);rows=regular.filter(r=>keep.has(r.week))
    }
    const payload={source:'nflverse player weekly stats',sourceUrl,season,dataSeason,targetWeek,history,rows,fallback:dataSeason!==season}
    store(key,payload,30*60_000)
    return c.json(payload)
  }catch(error){
    return c.json({error:'nflverse weekly stats failed',detail:error instanceof Error?error.message:String(error)},502)
  }
})


app.get('/diagnostic', (c) =>
  c.html(`<!doctype html>
  <html>
    <head><meta name="viewport" content="width=device-width,initial-scale=1"><title>NFL DFS Diagnostic</title></head>
    <body style="font-family:system-ui;padding:24px;background:#06111f;color:white">
      <h1>NFL DFS server is working</h1>
      <p>Hono API routing is healthy. If the home page fails, the problem is isolated to Vike/client rendering.</p>
    </body>
  </html>`)
)


app.get('/client-check', (c) =>
  c.html(`<!doctype html>
  <html>
    <head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Client Check</title></head>
    <body style="font-family:system-ui;padding:24px;background:#06111f;color:white">
      <h1>Browser JavaScript check</h1>
      <div id="status">JavaScript has not run yet.</div>
      <script>document.getElementById('status').textContent='JavaScript is running in Safari ✅'</script>
    </body>
  </html>`)
)

// Vike catch-all must be last.
vike(app)

export default {
  fetch: app.fetch,
  prod: {
    static: true
  }
} satisfies Server
