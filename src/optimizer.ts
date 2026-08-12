import { eligibleForSlot, NFL } from './sports'
import type { DfsPlayer, Lineup, LineupPlayer } from './types'

export type OptimizerSettings = {
  lineupCount: number
  salaryCap: number
  minSpend: number
  maxExposure: number
  minUnique: number
  randomness: number
  attempts: number
  requireStack: boolean
  requireBringBack: boolean
  maxTeamPlayers: number
}

const clamp = (n:number,a:number,b:number)=>Math.max(a,Math.min(b,n))

function rating(p:DfsPlayer) {
  const value = p.projection / Math.max(1, p.salary / 1000)
  return (p.dfsScore || p.projection * 3) * 0.72 + p.projection * 1.3 + value * 4
}

function weightedPick(items:DfsPlayer[], randomness:number) {
  if (!items.length) return undefined

  // Mostly choose from the best candidates, with enough noise for GPP diversity.
  const sampleSize = Math.min(items.length, 12)
  const sample = items.slice(0, sampleSize)
  if (randomness <= 0.01) return sample[0]

  const weights = sample.map((p, i) => {
    const rankPenalty = 1 / (1 + i * 0.16)
    const jitter = 1 + (Math.random() * 2 - 1) * randomness
    return Math.max(0.01, rating(p) * rankPenalty * jitter)
  })

  let r = Math.random() * weights.reduce((a,b)=>a+b,0)
  for (let i=0;i<sample.length;i++) {
    r -= weights[i]
    if (r <= 0) return sample[i]
  }
  return sample[0]
}

function lineupKey(l:Lineup){
  return l.players.map(p=>p.id||p.name).sort().join('|')
}

function uniqueEnough(a:Lineup,b:Lineup,n:number){
  const names=new Set(b.players.map(p=>p.name))
  return a.players.length-a.players.filter(p=>names.has(p.name)).length>=n
}

export function optimize(pool:DfsPlayer[], input:OptimizerSettings){
  const s = {
    ...input,
    lineupCount: clamp(input.lineupCount,1,150),
    // The old optimizer could run 30k-100k full-pool attempts on a phone.
    // Candidate pruning makes 1k-5k attempts plenty.
    attempts: clamp(input.attempts || 2500, 600, 5000),
    maxExposure: clamp(input.maxExposure,0.05,1),
    minUnique: clamp(input.minUnique,1,6)
  }

  const active = pool
    .filter(p=>!p.excluded && p.salary > 0 && p.projection > 0)
    .sort((a,b)=>rating(b)-rating(a))

  const locks = active.filter(p=>p.locked)
  const unlocked = active.filter(p=>!p.locked)

  // Precompute and prune candidate pools ONCE instead of filtering the
  // entire DraftKings slate nine times on every attempt.
  const candidates = new Map<string,DfsPlayer[]>()
  for (const slot of [...new Set(NFL.slots)]) {
    candidates.set(
      slot,
      unlocked
        .filter(p=>eligibleForSlot(p,slot))
        .slice(0, slot === 'FLEX' ? 42 : 30)
    )
  }

  function buildOne():Lineup|null {
    const chosen:(LineupPlayer|undefined)[] = Array(NFL.slots.length).fill(undefined)
    const used = new Set<string>()

    function placeLocks(i=0):boolean {
      if(i>=locks.length)return true
      const p=locks[i]
      for(let si=0;si<NFL.slots.length;si++){
        if(chosen[si] || !eligibleForSlot(p,NFL.slots[si]))continue
        chosen[si]={...p,assignedSlot:NFL.slots[si]}
        used.add(p.name)
        if(placeLocks(i+1))return true
        chosen[si]=undefined
        used.delete(p.name)
      }
      return false
    }
    if(!placeLocks())return null

    // Scarcer slots first.
    const remaining = NFL.slots
      .map((slot,i)=>({slot,i}))
      .filter(x=>!chosen[x.i])
      .sort((a,b)=>(candidates.get(a.slot)?.length||0)-(candidates.get(b.slot)?.length||0))

    let runningSalary = chosen.filter(Boolean).reduce((n,p)=>n+(p?.salary||0),0)

    for(const {slot,i} of remaining){
      const list = (candidates.get(slot)||[]).filter(p=>{
        if(used.has(p.name))return false
        if(runningSalary+p.salary>s.salaryCap)return false
        return true
      })

      const pick = weightedPick(list,s.randomness)
      if(!pick)return null
      chosen[i]={...pick,assignedSlot:slot}
      used.add(pick.name)
      runningSalary += pick.salary
    }

    const players=chosen.filter(Boolean) as LineupPlayer[]
    if(runningSalary>s.salaryCap || runningSalary<s.minSpend)return null

    const teamCounts=new Map<string,number>()
    for(const p of players){
      if(!p.team)continue
      teamCounts.set(p.team,(teamCounts.get(p.team)||0)+1)
      if((teamCounts.get(p.team)||0)>s.maxTeamPlayers)return null
    }

    const qb=players.find(p=>p.assignedSlot==='QB')
    if(qb && s.requireStack && !players.some(
      p=>p.name!==qb.name && p.team===qb.team && ['WR','TE'].includes(p.position)
    )) return null

    if(qb && s.requireBringBack && qb.opponent && !players.some(
      p=>p.team===qb.opponent && ['RB','WR','TE'].includes(p.position)
    )) return null

    return {
      players,
      salary:runningSalary,
      projection:players.reduce((n,p)=>n+p.projection,0),
      ceiling:players.reduce((n,p)=>n+p.ceiling,0)
    }
  }

  const generated=new Map<string,Lineup>()

  // Add a small deterministic phase first so strong lineups appear quickly.
  const originalRandomness=s.randomness
  for(let i=0;i<Math.min(150,s.attempts);i++){
    const l=buildOne()
    if(l)generated.set(lineupKey(l),l)
  }

  for(let i=0;i<s.attempts;i++){
    const l=buildOne()
    if(!l)continue
    const k=lineupKey(l),old=generated.get(k)
    if(!old || l.projection>old.projection)generated.set(k,l)

    // Stop early once there is a healthy candidate pool.
    if(generated.size >= Math.max(300, s.lineupCount * 12) && i > 1200) break
  }

  const ranked=[...generated.values()].sort(
    (a,b)=>(b.projection+b.ceiling*.08)-(a.projection+a.ceiling*.08)
  )

  const picked:Lineup[]=[]
  const exposure=new Map<string,number>()
  const maxCount=Math.max(1,Math.ceil(s.lineupCount*s.maxExposure))

  for(const l of ranked){
    if(picked.length>=s.lineupCount)break
    if(picked.some(x=>!uniqueEnough(l,x,s.minUnique)))continue
    if(l.players.some(p=>(exposure.get(p.name)||0)>=maxCount))continue
    picked.push(l)
    l.players.forEach(p=>exposure.set(p.name,(exposure.get(p.name)||0)+1))
  }

  return picked
}
