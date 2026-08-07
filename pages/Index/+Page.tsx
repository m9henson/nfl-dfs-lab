import React,{useMemo,useState} from 'react'
import { NFL } from '../../src/sports'
import { optimize } from '../../src/optimizer'
import { exportDraftKingsLineups,importDraftKingsCsv } from '../../src/csv'
import type { DfsPlayer,Lineup,Slate } from '../../src/types'
import '../../src/styles.css'

const fmt=new Intl.NumberFormat('en-US')
const money=(n:number)=>`$${fmt.format(n)}`
const clamp=(n:number,a=0,b=100)=>Math.max(a,Math.min(b,n))
const avg=(a:number[])=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0
const normalize=(s:string)=>s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\b(jr|sr|ii|iii|iv)\b/g,'').replace(/[^a-z0-9]/g,'')

function download(name:string,text:string){
 const blob=new Blob([text],{type:'text/csv'}),url=URL.createObjectURL(blob),a=document.createElement('a')
 a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),500)
}

function scorePlayer(p:DfsPlayer):DfsPlayer{
 const pos=p.position.toUpperCase()
 let opportunity=50
 if(pos==='RB') opportunity=clamp(25+(p.carries||0)*2+(p.targets||0)*3+(p.redZoneTouches||0)*4)
 if(pos==='WR'||pos==='TE') opportunity=clamp(20+(p.targets||0)*5+(p.targetShare||0)*120+(p.airYardsShare||0)*45+(p.redZoneTouches||0)*4)
 if(pos==='QB') opportunity=clamp(40+(p.projection||0)*1.5)
 if(pos==='DST') opportunity=clamp(45+(p.projection||0)*3)

 const matchup=clamp(100-((p.defenseVsPositionRank||16)-1)*(100/31))
 const vegas=clamp(35+((p.gameTotal||44)-40)*3+((p.teamImplied||22)-20)*4-(Math.max(0,p.spread||0))*1.5)
 const rawValue=p.salary?p.projection/(p.salary/1000):0
 const value=clamp(rawValue*18)
 const ceiling=clamp((p.ceiling||p.projection*1.25)*3)
 const leverage=clamp((p.ceiling||0)*2.2-(p.ownership||0)*1.5+20)
 const dfs=clamp(opportunity*.27+matchup*.16+vegas*.14+value*.20+ceiling*.15+leverage*.08)
 return {...p,opportunityScore:opportunity,matchupScore:matchup,vegasScore:vegas,valueScore:value,ceilingScore:ceiling,leverageScore:leverage,dfsScore:dfs}
}

export function Page(){
 const [slates,setSlates]=useState<Slate[]>([])
 const [slateId,setSlateId]=useState('')
 const [players,setPlayers]=useState<DfsPlayer[]>([])
 const [lineups,setLineups]=useState<Lineup[]>([])
 const [loading,setLoading]=useState('')
 const [error,setError]=useState('')
 const [season,setSeason]=useState(2026)
 const [week,setWeek]=useState(1)
 const [dataStatus,setDataStatus]=useState<string[]>([])
 const [tab,setTab]=useState<'dashboard'|'players'|'optimizer'|'lineups'>('dashboard')
 const [settings,setSettings]=useState({lineupCount:20,salaryCap:50000,minSpend:48000,maxExposure:.7,minUnique:2,randomness:.08,attempts:30000,requireStack:true,requireBringBack:false,maxTeamPlayers:4})

 const scored=useMemo(()=>players.map(scorePlayer).sort((a,b)=>(b.dfsScore||0)-(a.dfsScore||0)),[players])
 const top=useMemo(()=>scored.slice(0,12),[scored])

 async function fetchSlates(){
  setLoading('slates');setError('')
  try{
   const r=await fetch('/api/dk/slates');const d=await r.json()
   if(!r.ok)throw Error(d.detail||d.error)
   setSlates(d.slates||[]);if(d.slates?.length)setSlateId(String(d.slates[0].draftGroupId))
  }catch(e){setError(String(e))}finally{setLoading('')}
 }
 async function fetchPool(){
  if(!slateId)return
  setLoading('pool');setError('')
  try{
   const r=await fetch(`/api/dk/draftables?draftGroupId=${slateId}`),d=await r.json()
   if(!r.ok)throw Error(d.detail||d.error)
   setPlayers((d.players||[]).map((p:any)=>scorePlayer({...p,id:String(p.id),eligiblePositions:p.eligiblePositions||[p.position],fppg:Number(p.fppg)||0,projection:Number(p.fppg)||0,ceiling:(Number(p.fppg)||0)*1.28,ownership:0})))
   setDataStatus(s=>[...s.filter(x=>!x.startsWith('DraftKings')),'DraftKings salaries loaded'])
  }catch(e){setError(String(e))}finally{setLoading('')}
 }
 async function importCsv(file?:File){
  if(!file)return
  const imported=importDraftKingsCsv(await file.text()).map(scorePlayer)
  setPlayers(imported);setDataStatus(s=>[...s,'DraftKings CSV imported'])
 }
 async function loadNFLVerse(){
  if(!players.length)return setError('Load a DraftKings slate first.')
  setLoading('nflverse');setError('')
  try{
   const r=await fetch(`/api/nfl/weekly-stats?season=${season}&week=${week}&history=5`),d=await r.json()
   if(!r.ok)throw Error(d.detail||d.error)
   const grouped=new Map<string,any[]>()
   for(const row of d.rows||[]){
    const k=normalize(row.name);grouped.set(k,[...(grouped.get(k)||[]),row])
   }
   setPlayers(all=>all.map(p=>{
    const rows=grouped.get(normalize(p.name))||[]
    if(!rows.length)return p
    return scorePlayer({...p,
      targets:avg(rows.map(x=>x.targets)),carries:avg(rows.map(x=>x.carries)),
      receptions:avg(rows.map(x=>x.receptions)),targetShare:avg(rows.map(x=>x.targetShare)),
      airYardsShare:avg(rows.map(x=>x.airYardsShare)),wopr:avg(rows.map(x=>x.wopr)),
      projection:avg(rows.map(x=>x.fantasyPoints))||p.projection,
      ceiling:Math.max(...rows.map(x=>x.fantasyPoints),p.ceiling)
    })
   }))
   setDataStatus(s=>[...s.filter(x=>!x.startsWith('nflverse')),'nflverse usage/history loaded'])
  }catch(e){setError(String(e))}finally{setLoading('')}
 }
 async function loadWWO(){
  if(!players.length)return setError('Load a DraftKings slate first.')
  setLoading('wwo');setError('')
  try{
   const r=await fetch('/api/values/football'),d=await r.json()
   if(!r.ok)throw Error(d.detail||d.error)
   const map=new Map((d.values||[]).map((x:any)=>[normalize(x.name),x]))
   setPlayers(all=>all.map(p=>{const x:any=map.get(normalize(p.name));return x?scorePlayer({...p,projection:+x.projection,ceiling:Math.max(+x.projection*1.28,p.ceiling),externalProjection:+x.projection,externalValue:+x.value,externalSource:d.source}):p}))
   setDataStatus(s=>[...s.filter(x=>!x.startsWith('Win With Odds')),'Win With Odds projections loaded'])
  }catch(e){setError(String(e))}finally{setLoading('')}
 }
 function patch(name:string,x:Partial<DfsPlayer>){setPlayers(all=>all.map(p=>p.name===name?scorePlayer({...p,...x}):p))}
 function run(){const generated=optimize(scored,settings);setLineups(generated);setTab('lineups');if(!generated.length)setError('No lineups found. Lower minimum spend or loosen constraints.')}
 function exportCsv(){download(`nfl-dk-lineups-week-${week}.csv`,exportDraftKingsLineups(lineups))}

 return <main className="shell">
  <section className="hero card">
   <div className="eyebrow">NFL ONLY · WEEKLY DFS COMMAND CENTER</div>
   <h2>Research the slate. Understand every play. Build stronger DraftKings lineups.</h2>
   <div className="tabs">
    {(['dashboard','players','optimizer','lineups'] as const).map(x=><button className={tab===x?'sport active':'sport'} onClick={()=>setTab(x)} key={x}>{x}</button>)}
   </div>
  </section>
  {error&&<div className="alert">{error}</div>}

  {tab==='dashboard'&&<>
   <section className="grid two">
    <div className="card">
     <div className="cardTitle"><div><span className="step">1</span><strong>DraftKings slate</strong></div></div>
     <div className="formGrid">
      <label>Season<input type="number" value={season} onChange={e=>setSeason(+e.target.value)}/></label>
      <label>Week<input type="number" min="1" max="22" value={week} onChange={e=>setWeek(+e.target.value)}/></label>
     </div>
     <div className="buttonRow">
      <button className="primary" onClick={fetchSlates}>{loading==='slates'?'Loading…':'Find NFL slates'}</button>
      <label className="fileBtn">Import DK CSV<input type="file" accept=".csv" onChange={e=>importCsv(e.target.files?.[0])}/></label>
     </div>
     {!!slates.length&&<div className="formStack"><select value={slateId} onChange={e=>setSlateId(e.target.value)}>{slates.map(s=><option value={s.draftGroupId} key={s.draftGroupId}>{s.name}</option>)}</select><button className="primary" onClick={fetchPool}>Load salary pool</button></div>}
    </div>
    <div className="card">
     <div className="cardTitle"><div><span className="step">2</span><strong>NFL data sources</strong></div></div>
     <button className="secondary wide" onClick={loadNFLVerse}>{loading==='nflverse'?'Loading…':'Load nflverse usage + history'}</button>
     <button className="secondary wide" onClick={loadWWO}>{loading==='wwo'?'Loading…':'Load Win With Odds projections'}</button>
     <div className="sourceList">{dataStatus.length?dataStatus.map(x=><div className="sourceStatus" key={x}>✓ {x}</div>):<div className="empty">No data loaded yet.</div>}</div>
    </div>
   </section>
   <section className="card">
    <div className="cardTitle"><div><span className="step">3</span><strong>Top NFL DFS plays</strong></div><span className="badge">{players.length} players</span></div>
    <div className="scoreGrid">{top.map((p,i)=><article className="scoreCard" key={p.name}>
     <div className="rank">{i+1}</div><div><strong>{p.name}</strong><div className="muted tiny">{p.position} · {p.team} · {money(p.salary)}</div></div><div className="bigScore">{p.dfsScore?.toFixed(0)}</div>
     <div className="breakdown"><span>Opp {p.opportunityScore?.toFixed(0)}</span><span>Match {p.matchupScore?.toFixed(0)}</span><span>Value {p.valueScore?.toFixed(0)}</span><span>Ceil {p.ceilingScore?.toFixed(0)}</span></div>
    </article>)}</div>
   </section>
  </>}

  {tab==='players'&&<section className="card">
   <div className="cardTitle"><div><strong>Player research</strong></div><span className="badge">{players.length}</span></div>
   <div className="playerList">{scored.map(p=><article className={`player ${p.excluded?'dim':''}`} key={p.name}>
    <div className="playerMain"><div className="pos">{p.position}</div><div><strong>{p.name}</strong><div className="muted tiny">{p.team} vs {p.opponent||'—'} · {money(p.salary)} · DFS {p.dfsScore?.toFixed(0)}</div></div></div>
    <label className="mini">Projection<input type="number" step=".1" value={p.projection} onChange={e=>patch(p.name,{projection:+e.target.value})}/></label>
    <label className="mini">Ownership %<input type="number" step=".1" value={p.ownership} onChange={e=>patch(p.name,{ownership:+e.target.value})}/></label>
    <div className="playerActions"><button className={p.locked?'smallBtn locked':'smallBtn'} onClick={()=>patch(p.name,{locked:!p.locked,excluded:false})}>{p.locked?'Locked':'Lock'}</button><button className={p.excluded?'smallBtn excluded':'smallBtn'} onClick={()=>patch(p.name,{excluded:!p.excluded,locked:false})}>{p.excluded?'Excluded':'Exclude'}</button></div>
    <div className="metricStrip"><span>Targets {p.targets?.toFixed(1)||'—'}</span><span>Carries {p.carries?.toFixed(1)||'—'}</span><span>Tgt share {p.targetShare?`${(p.targetShare*100).toFixed(0)}%`:'—'}</span><span>Value {p.valueScore?.toFixed(0)}</span></div>
   </article>)}</div>
  </section>}

  {tab==='optimizer'&&<section className="card">
   <div className="cardTitle"><div><strong>NFL lineup optimizer</strong></div></div>
   <div className="formGrid">
    <label>Lineups<input type="number" value={settings.lineupCount} onChange={e=>setSettings({...settings,lineupCount:+e.target.value})}/></label>
    <label>Minimum spend<input type="number" value={settings.minSpend} onChange={e=>setSettings({...settings,minSpend:+e.target.value})}/></label>
    <label>Max exposure %<input type="number" value={settings.maxExposure*100} onChange={e=>setSettings({...settings,maxExposure:+e.target.value/100})}/></label>
    <label>Minimum unique<input type="number" value={settings.minUnique} onChange={e=>setSettings({...settings,minUnique:+e.target.value})}/></label>
    <label>Randomness %<input type="number" value={settings.randomness*100} onChange={e=>setSettings({...settings,randomness:+e.target.value/100})}/></label>
    <label>Max per team<input type="number" value={settings.maxTeamPlayers} onChange={e=>setSettings({...settings,maxTeamPlayers:+e.target.value})}/></label>
   </div>
   <label className="check"><input type="checkbox" checked={settings.requireStack} onChange={e=>setSettings({...settings,requireStack:e.target.checked})}/> Require QB + WR/TE stack</label>
   <label className="check"><input type="checkbox" checked={settings.requireBringBack} onChange={e=>setSettings({...settings,requireBringBack:e.target.checked})}/> Require opponent bring-back</label>
   <button className="generate wide" disabled={!players.length} onClick={run}>Generate NFL lineups</button>
  </section>}

  {tab==='lineups'&&<section className="card">
   <div className="cardTitle"><div><strong>Generated DraftKings lineups</strong></div><button className="secondary" disabled={!lineups.length} onClick={exportCsv}>Export DK CSV</button></div>
   <div className="lineups">{lineups.map((l,i)=><article className="lineup" key={i}><div className="lineupHead"><div><strong>Lineup {i+1}</strong><div className="muted tiny">{money(l.salary)}</div></div><div className="score">{l.projection.toFixed(1)}<span>proj</span></div><div className="score ceiling">{l.ceiling.toFixed(1)}<span>ceil</span></div></div><div className="slots">{l.players.map((p,j)=><div className="slot" key={j}><b>{p.assignedSlot}</b><span>{p.name}</span><small>{p.team} · {money(p.salary)} · DFS {p.dfsScore?.toFixed(0)}</small></div>)}</div></article>)}</div>
  </section>}
 </main>
}
