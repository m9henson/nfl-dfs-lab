import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import vike from '@vikejs/hono'
import type { Server } from 'vike/types'
import OpenAI from 'openai'
import * as cheerio from 'cheerio'
import { gunzipSync } from 'node:zlib'
import { parse as parseCsv } from 'csv-parse/sync'

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


const NFL_STADIUMS: Record<string,{lat:number;lon:number;dome?:boolean}> = {
ARI:{lat:33.5276,lon:-112.2626,dome:true},ATL:{lat:33.7553,lon:-84.4006,dome:true},BAL:{lat:39.2780,lon:-76.6227},BUF:{lat:42.7738,lon:-78.7870},CAR:{lat:35.2258,lon:-80.8528},CHI:{lat:41.8623,lon:-87.6167},CIN:{lat:39.0954,lon:-84.5160},CLE:{lat:41.5061,lon:-81.6995},DAL:{lat:32.7473,lon:-97.0945,dome:true},DEN:{lat:39.7439,lon:-105.0201},DET:{lat:42.3400,lon:-83.0456,dome:true},GB:{lat:44.5013,lon:-88.0622},HOU:{lat:29.6847,lon:-95.4107,dome:true},IND:{lat:39.7601,lon:-86.1639,dome:true},JAX:{lat:30.3239,lon:-81.6373},KC:{lat:39.0489,lon:-94.4839},LV:{lat:36.0908,lon:-115.1830,dome:true},LAC:{lat:33.9535,lon:-118.3392,dome:true},LAR:{lat:33.9535,lon:-118.3392,dome:true},MIA:{lat:25.9580,lon:-80.2389},MIN:{lat:44.9738,lon:-93.2581,dome:true},NE:{lat:42.0909,lon:-71.2643},NO:{lat:29.9511,lon:-90.0812,dome:true},NYG:{lat:40.8135,lon:-74.0745},NYJ:{lat:40.8135,lon:-74.0745},PHI:{lat:39.9008,lon:-75.1675},PIT:{lat:40.4468,lon:-80.0158},SEA:{lat:47.5952,lon:-122.3316},SF:{lat:37.4030,lon:-121.9700},TB:{lat:27.9759,lon:-82.5033},TEN:{lat:36.1665,lon:-86.7713},WAS:{lat:38.9076,lon:-76.8645}}
function normalizeName(s:string){return (s||'').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').replace(/\\b(jr|sr|ii|iii|iv)\\b/g,'').replace(/[^a-z0-9]/g,'')}
function rankDefenseVsPosition(rows:any[]){const b=new Map<string,{points:number;weeks:Set<number>}>();for(const r of rows){const d=String(r.opponent||'').toUpperCase(),p=String(r.position||'').toUpperCase();if(!d||!['QB','RB','WR','TE'].includes(p))continue;const k=`${d}|${p}`,v=b.get(k)||{points:0,weeks:new Set<number>()};v.points+=Number(r.fantasyPoints||0)||0;v.weeks.add(Number(r.week)||0);b.set(k,v)}const out:Record<string,Record<string,{rank:number;avg:number}>>={};for(const p of ['QB','RB','WR','TE']){const a=[...b.entries()].filter(([k])=>k.endsWith(`|${p}`)).map(([k,v])=>({team:k.split('|')[0],avg:v.points/Math.max(1,v.weeks.size)})).sort((x,y)=>x.avg-y.avg);out[p]={};a.forEach((x,i)=>out[p][x.team]={rank:i+1,avg:x.avg})}return out}

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



app.get('/api/nfl/sleeper/players',async c=>{const k='sleeper:nfl:players',h=cached<any>(k);if(h)return c.json(h);try{const players=await fetchJson('https://api.sleeper.app/v1/players/nfl?active=true');const p={source:'Sleeper API',players};store(k,p,86400000);return c.json(p)}catch(e){return c.json({error:'Sleeper player fetch failed',detail:e instanceof Error?e.message:String(e)},502)}})
app.get('/api/nfl/sleeper/trending',async c=>{const h=Math.max(1,Math.min(168,Number(c.req.query('hours')||24))),l=Math.max(5,Math.min(100,Number(c.req.query('limit')||50)));try{return c.json({source:'Sleeper trending adds',rows:await fetchJson(`https://api.sleeper.app/v1/players/nfl/trending/add?lookback_hours=${h}&limit=${l}`)})}catch(e){return c.json({error:'Sleeper trending fetch failed',detail:e instanceof Error?e.message:String(e)},502)}})
app.get('/api/nfl/weather',async c=>{const team=String(c.req.query('homeTeam')||'').toUpperCase(),st=NFL_STADIUMS[team];if(!st)return c.json({error:'Unknown home team'},400);if(st.dome)return c.json({source:'stadium metadata',dome:true,weather:{score:100}});try{const u=new URL('https://api.open-meteo.com/v1/forecast');u.searchParams.set('latitude',String(st.lat));u.searchParams.set('longitude',String(st.lon));u.searchParams.set('hourly','temperature_2m,precipitation_probability,wind_speed_10m,wind_gusts_10m');u.searchParams.set('temperature_unit','fahrenheit');u.searchParams.set('wind_speed_unit','mph');u.searchParams.set('timezone','auto');u.searchParams.set('forecast_days','16');const d=await fetchJson(u.toString()),i=0,temp=Number(d?.hourly?.temperature_2m?.[i]||0),wind=Number(d?.hourly?.wind_speed_10m?.[i]||0),gust=Number(d?.hourly?.wind_gusts_10m?.[i]||0),precip=Number(d?.hourly?.precipitation_probability?.[i]||0);let score=100;if(wind>=20)score-=28;else if(wind>=15)score-=18;else if(wind>=10)score-=8;if(gust>=30)score-=12;if(precip>=70)score-=12;else if(precip>=40)score-=6;if(temp<=25)score-=6;return c.json({source:'Open-Meteo',dome:false,weather:{tempF:temp,windMph:wind,gustMph:gust,precipProb:precip,score:Math.max(0,score)}})}catch(e){return c.json({error:'Weather fetch failed',detail:e instanceof Error?e.message:String(e)},502)}})
app.get('/api/nfl/redzone', async c => {
  const requestedSeason = Number(c.req.query('season') || new Date().getFullYear())
  const targetWeek = Number(c.req.query('week') || 1)
  const history = Math.max(1, Math.min(8, Number(c.req.query('history') || 5)))

  async function loadSeasonPbp(season: number) {
    const cacheKey = `nflverse:redzone:season:${season}`
    const cachedSeason = cached<any>(cacheKey)
    if (cachedSeason) return cachedSeason

    const url = `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${season}.csv.gz`
    const r = await fetch(url, { headers: { 'user-agent': 'NFLDFSLab/1.1' } })
    if (!r.ok) throw new Error(`nflverse PBP ${season} returned ${r.status}`)

    const csv = gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8')
    const rows = parseCsv(csv, {
      columns: true,
      skip_empty_lines: true,
      relax_quotes: true,
      relax_column_count: true
    }) as any[]

    // Store only the fields this app needs, which makes subsequent requests cheap.
    const compact = rows
      .filter(x => String(x.season_type || 'REG') === 'REG')
      .map(x => ({
        week: Number(x.week),
        yardline: Number(x.yardline_100),
        team: String(x.posteam || ''),
        receiver: String(x.receiver_player_name || ''),
        rusher: String(x.rusher_player_name || ''),
        passAttempt: Number(x.pass_attempt) === 1,
        rushAttempt: Number(x.rush_attempt) === 1
      }))

    store(cacheKey, compact, 6 * 60 * 60_000)
    return compact
  }

  try {
    // Week 1 has no current-season historical PBP. Use the prior season's
    // final regular-season weeks as a baseline. For later weeks, try the
    // current season first and automatically fall back if the release isn't live yet.
    let sourceSeason = targetWeek <= 1 ? requestedSeason - 1 : requestedSeason
    let rows: any[]

    try {
      rows = await loadSeasonPbp(sourceSeason)
    } catch (error) {
      if (sourceSeason === requestedSeason) {
        sourceSeason = requestedSeason - 1
        rows = await loadSeasonPbp(sourceSeason)
      } else {
        throw error
      }
    }

    const sourceTargetWeek = sourceSeason === requestedSeason ? targetWeek : 19
    const minWeek = Math.max(1, sourceTargetWeek - history)
    const agg = new Map<string, any>()

    const add = (name: string, team: string, yardline: number, target: boolean, carry: boolean) => {
      if (!name || !team || !Number.isFinite(yardline) || yardline > 20) return
      const key = normalizeName(name)
      const v = agg.get(key) || {
        name,
        team,
        redZoneTouches: 0,
        insideTenTouches: 0,
        insideFiveTouches: 0,
        redZoneTargets: 0,
        redZoneCarries: 0
      }
      v.redZoneTouches++
      if (yardline <= 10) v.insideTenTouches++
      if (yardline <= 5) v.insideFiveTouches++
      if (target) v.redZoneTargets++
      if (carry) v.redZoneCarries++
      agg.set(key, v)
    }

    for (const x of rows) {
      if (x.week < minWeek || x.week >= sourceTargetWeek) continue
      if (x.passAttempt) add(x.receiver, x.team, x.yardline, true, false)
      if (x.rushAttempt) add(x.rusher, x.team, x.yardline, false, true)
    }

    return c.json({
      source: 'nflverse play-by-play',
      requestedSeason,
      sourceSeason,
      targetWeek,
      history,
      fallbackUsed: sourceSeason !== requestedSeason,
      players: [...agg.values()]
    })
  } catch (e) {
    return c.json({
      error: 'nflverse red-zone fetch failed',
      detail: e instanceof Error ? e.message : String(e)
    }, 502)
  }
})


app.get('/api/nfl/weekly-stats', async (c) => {
  const season = Number(c.req.query('season') || new Date().getFullYear())
  const targetWeek = Number(c.req.query('week') || 1)
  const history = Math.max(1, Math.min(8, Number(c.req.query('history') || 5)))
  if (!Number.isInteger(season) || !Number.isInteger(targetWeek)) {
    return c.json({ error: 'Invalid season/week' }, 400)
  }

  const key = `nflverse:${season}:${targetWeek}:${history}`
  const hit = cached<any>(key)
  if (hit) return c.json(hit)

  try {
    const url = `https://github.com/nflverse/nflverse-data/releases/download/player_stats/stats_player_week_${season}.csv`
    const res = await fetch(url, { headers: { 'user-agent': 'NFLDFSLab/1.0' } })
    if (!res.ok) throw new Error(`nflverse returned ${res.status}`)
    const text = await res.text()
    const lines = text.replace(/\r/g,'').split('\n').filter(Boolean)
    const headers = lines[0].split(',')
    const ix = (names:string[]) => names.map(n=>headers.indexOf(n)).find(i=>i>=0) ?? -1
    const col = {
      week: ix(['week']), name: ix(['player_display_name','player_name']),
      pos: ix(['position','position_group']), team: ix(['recent_team','team']),
      opp: ix(['opponent_team','opponent']), targets: ix(['targets']),
      carries: ix(['carries','rushing_attempts']), receptions: ix(['receptions']),
      fantasy: ix(['fantasy_points_ppr','fantasy_points']),
      targetShare: ix(['target_share','tgt_sh']), airShare: ix(['air_yards_share','ay_sh']),
      wopr: ix(['wopr'])
    }
    const minWeek=Math.max(1,targetWeek-history)
    const rows=lines.slice(1).map(line=>line.split(',')).filter(r=>{
      const w=Number(r[col.week]);return w>=minWeek&&w<targetWeek
    }).map(r=>({
      week:Number(r[col.week]),name:r[col.name]||'',position:r[col.pos]||'',
      team:r[col.team]||'',opponent:r[col.opp]||'',
      targets:Number(r[col.targets]||0),carries:Number(r[col.carries]||0),
      receptions:Number(r[col.receptions]||0),fantasyPoints:Number(r[col.fantasy]||0),
      targetShare:Number(r[col.targetShare]||0),airYardsShare:Number(r[col.airShare]||0),
      wopr:Number(r[col.wopr]||0)
    }))
    const defenseRanks=rankDefenseVsPosition(rows)
    const payload={source:'nflverse player weekly stats',season,targetWeek,history,rows,defenseRanks}
    store(key,payload,30*60_000)
    return c.json(payload)
  } catch(error) {
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


type OptP={id:string;name:string;position:string;eligiblePositions?:string[];salary:number;team:string;opponent?:string;projection:number;ceiling?:number;dfsScore?:number;locked?:boolean;excluded?:boolean}
const OPT_SLOTS=['QB','RB','RB','WR','WR','WR','TE','FLEX','DST']
const optEligible=(p:OptP,s:string)=>s==='FLEX'?['RB','WR','TE'].includes(p.position):s==='DST'?['DST','DEF'].includes(p.position):p.position===s
const optRating=(p:OptP)=>Number(p.projection||0)+Number(p.dfsScore||0)*.05+Number(p.ceiling||0)*.03

function solveFast(pool:OptP[],count:number,cap:number,minSpend:number,minUnique:number,maxExposure:number,stack:boolean,bringBack:boolean){
 const active=pool.filter(p=>!p.excluded&&p.salary>0&&p.projection>0), exposure=new Map<string,number>(), results:any[]=[], previous:Set<string>[]=[]
 const maxCount=Math.max(1,Math.ceil(count*maxExposure)), deadline=Date.now()+7000
 const by=new Map<string,OptP[]>()
 for(const slot of [...new Set(OPT_SLOTS)]) by.set(slot,active.filter(p=>optEligible(p,slot)).sort((a,b)=>optRating(b)-optRating(a)).slice(0,slot==='FLEX'?32:24))
 for(let n=0;n<count&&Date.now()<deadline;n++){
  let best:any=null
  const chosen:any[]=[],used=new Set<string>(),teams=new Map<string,number>()
  const order=OPT_SLOTS.map(slot=>({slot})).sort((a,b)=>(by.get(a.slot)?.length||0)-(by.get(b.slot)?.length||0))
  function dfs(d:number,sal:number,score:number){
   if(Date.now()>=deadline||sal>cap)return
   if(d===order.length){
    if(sal<minSpend)return
    if(active.filter(p=>p.locked).some(p=>!used.has(p.id)))return
    const ids=new Set(chosen.map(p=>p.id))
    for(const old of previous){let overlap=0;ids.forEach(id=>{if(old.has(id))overlap++});if(9-overlap<minUnique)return}
    if(chosen.some(p=>(exposure.get(p.id)||0)>=maxCount))return
    const qb=chosen.find(p=>p.assignedSlot==='QB')
    if(qb&&stack&&!chosen.some(p=>p.id!==qb.id&&p.team===qb.team&&['WR','TE'].includes(p.position)))return
    if(qb&&bringBack&&qb.opponent&&!chosen.some(p=>p.team===qb.opponent&&['RB','WR','TE'].includes(p.position)))return
    if(!best||score>best.score)best={players:[...chosen],salary:sal,projection:chosen.reduce((x,p)=>x+Number(p.projection||0),0),score}
    return
   }
   const slot=order[d].slot
   const candidates=[...(by.get(slot)||[])].sort((a,b)=>(optRating(b)-(exposure.get(b.id)||0)*1.5)-(optRating(a)-(exposure.get(a.id)||0)*1.5))
   for(const p of candidates){
    if(used.has(p.id)||(exposure.get(p.id)||0)>=maxCount)continue
    const tc=teams.get(p.team)||0;if(tc>=4)continue
    chosen.push({...p,assignedSlot:slot});used.add(p.id);teams.set(p.team,tc+1)
    dfs(d+1,sal+p.salary,score+optRating(p)-(exposure.get(p.id)||0)*1.5)
    chosen.pop();used.delete(p.id);if(tc)teams.set(p.team,tc);else teams.delete(p.team)
   }
  }
  dfs(0,0,0);if(!best)break
  results.push(best);previous.push(new Set(best.players.map((p:any)=>p.id)));best.players.forEach((p:any)=>exposure.set(p.id,(exposure.get(p.id)||0)+1))
 }
 return results
}

app.post('/api/nfl/optimize',async c=>{
 const started=Date.now()
 try{const b=await c.req.json() as any, players=Array.isArray(b.players)?b.players:[]
  if(!players.length)return c.json({error:'No player pool supplied'},400)
  const lineups=solveFast(players,Math.min(50,Math.max(1,Number(b.lineupCount||20))),Number(b.salaryCap||50000),Number(b.minSpend||48500),Math.max(1,Number(b.minUnique||2)),Math.max(.1,Math.min(1,Number(b.maxExposure||.7))),b.requireStack!==false,Boolean(b.requireBringBack))
  return c.json({lineups,elapsedMs:Date.now()-started})
 }catch(e){return c.json({error:'Optimizer failed',detail:e instanceof Error?e.message:String(e)},500)}
})

app.post('/api/nfl/prepare-week',async c=>{
 const b=await c.req.json().catch(()=>({})) as any, season=Number(b.season||new Date().getFullYear()),week=Number(b.week||1),players=Array.isArray(b.players)?b.players:[]
 if(!players.length)return c.json({error:'Load or import a DraftKings slate first.'},400)
 const warnings:string[]=[],status:any={draftKings:true,nflverse:false,sleeper:false};let rows:any[]=[],sl:any={}
 try{
  let sourceSeason=week<=1?season-1:season
  let r=await fetch(`https://github.com/nflverse/nflverse-data/releases/download/player_stats/stats_player_week_${sourceSeason}.csv`,{headers:{'user-agent':'NFLDFSLab/2.0'}})
  if(!r.ok&&sourceSeason===season){sourceSeason=season-1;r=await fetch(`https://github.com/nflverse/nflverse-data/releases/download/player_stats/stats_player_week_${sourceSeason}.csv`)}
  if(r.ok){rows=parseCsv(await r.text(),{columns:true,skip_empty_lines:true,relax_column_count:true}) as any[];const target=sourceSeason===season?week:19,min=Math.max(1,target-5);rows=rows.filter(x=>Number(x.week)>=min&&Number(x.week)<target);status.nflverse=true;status.nflverseSeason=sourceSeason}else warnings.push('nflverse unavailable')
 }catch(e){warnings.push('nflverse unavailable')}
 try{sl=await fetchJson('https://api.sleeper.app/v1/players/nfl?active=true');status.sleeper=true}catch(e){warnings.push('Sleeper unavailable')}
 const hist=new Map<string,any[]>();for(const x of rows){const k=normalizeName(String(x.player_display_name||x.player_name||''));if(k){const a=hist.get(k)||[];a.push(x);hist.set(k,a)}}
 const sm=new Map<string,any>();Object.values(sl||{}).forEach((x:any)=>{const k=normalizeName(`${x.first_name||''} ${x.last_name||''}`);if(k)sm.set(k,x)})
 const merged=players.map((p:any)=>{const h=hist.get(normalizeName(p.name))||[],x=sm.get(normalizeName(p.name)),avg=(f:string)=>h.length?h.reduce((n,z)=>n+(Number(z[f])||0),0)/h.length:0
  return {...p,projection:Number(p.projection||p.fppg||0)||avg('fantasy_points_ppr'),targets:avg('targets'),carries:avg('carries'),receptions:avg('receptions'),targetShare:avg('target_share'),airYardsShare:avg('air_yards_share'),wopr:avg('wopr'),injuryStatus:x?.injury_status||x?.status||'',practiceParticipation:x?.practice_participation||'',depthChartOrder:Number(x?.depth_chart_order||0)||undefined,dataGames:h.length}})
 return c.json({season,week,players:merged,sourceStatus:status,warnings,preparedAt:new Date().toISOString()})
})

// Vike catch-all must be last.
vike(app)

export default {
  fetch: app.fetch,
  prod: {
    static: true
  }
} satisfies Server
