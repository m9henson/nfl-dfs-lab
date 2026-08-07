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

function weightedPick(items:DfsPlayer[], randomness:number) {
  if (!items.length) return undefined
  const weights = items.map((p) => {
    const score = p.dfsScore || p.projection
    const value = p.projection / Math.max(1, p.salary / 1000)
    const variance = 1 + (Math.random()*2-1)*randomness
    return Math.max(.01, Math.pow(score*.75 + value*5, 1.35) * variance)
  })
  let r = Math.random()*weights.reduce((a,b)=>a+b,0)
  for (let i=0;i<items.length;i++) {
    r -= weights[i]
    if (r <= 0) return items[i]
  }
  return items.at(-1)
}

function buildOne(pool:DfsPlayer[], s:OptimizerSettings):Lineup|null {
  const chosen:(LineupPlayer|undefined)[] = Array(NFL.slots.length).fill(undefined)
  const used = new Set<string>()
  const locks = pool.filter((p)=>p.locked&&!p.excluded)

  function placeLocks(i=0):boolean {
    if (i>=locks.length) return true
    const p=locks[i]
    for (let slotIndex=0;slotIndex<NFL.slots.length;slotIndex++) {
      if (chosen[slotIndex] || !eligibleForSlot(p,NFL.slots[slotIndex])) continue
      chosen[slotIndex]={...p,assignedSlot:NFL.slots[slotIndex]}
      used.add(p.name)
      if(placeLocks(i+1)) return true
      chosen[slotIndex]=undefined
      used.delete(p.name)
    }
    return false
  }
  if(!placeLocks()) return null

  const order=NFL.slots.map((slot,i)=>({slot,i}))
    .filter(({i})=>!chosen[i])
    .sort((a,b)=>{
      const ca=pool.filter(p=>!p.excluded&&eligibleForSlot(p,a.slot)).length
      const cb=pool.filter(p=>!p.excluded&&eligibleForSlot(p,b.slot)).length
      return ca-cb
    })

  for(const {slot,i} of order){
    const candidates=pool.filter(p=>!p.excluded&&!used.has(p.name)&&eligibleForSlot(p,slot))
    const pick=weightedPick(candidates,s.randomness)
    if(!pick)return null
    chosen[i]={...pick,assignedSlot:slot};used.add(pick.name)
  }

  const players=chosen.filter(Boolean) as LineupPlayer[]
  const salary=players.reduce((n,p)=>n+p.salary,0)
  if(salary>s.salaryCap||salary<s.minSpend)return null

  const teamCounts=new Map<string,number>()
  for(const p of players){
    if(!p.team)continue
    teamCounts.set(p.team,(teamCounts.get(p.team)||0)+1)
    if((teamCounts.get(p.team)||0)>s.maxTeamPlayers)return null
  }

  const qb=players.find(p=>p.assignedSlot==='QB')
  if(qb&&s.requireStack&&!players.some(p=>p.team===qb.team&&['WR','TE'].includes(p.position)))return null
  if(qb&&s.requireBringBack&&!players.some(p=>p.team===qb.opponent&&['RB','WR','TE'].includes(p.position)))return null

  return {
    players,
    salary,
    projection:players.reduce((n,p)=>n+p.projection,0),
    ceiling:players.reduce((n,p)=>n+p.ceiling,0)
  }
}

function key(l:Lineup){return l.players.map(p=>p.id||p.name).sort().join('|')}
function uniqueEnough(a:Lineup,b:Lineup,n:number){
  const names=new Set(b.players.map(p=>p.name))
  return a.players.length-a.players.filter(p=>names.has(p.name)).length>=n
}

export function optimize(pool:DfsPlayer[], input:OptimizerSettings){
  const s={...input,lineupCount:clamp(input.lineupCount,1,150),attempts:clamp(input.attempts,1000,100000)}
  const candidates=new Map<string,Lineup>()
  for(let i=0;i<s.attempts;i++){
    const l=buildOne(pool,s);if(!l)continue
    const k=key(l),old=candidates.get(k)
    if(!old||l.projection>old.projection)candidates.set(k,l)
  }
  const ranked=[...candidates.values()].sort((a,b)=>(b.projection+b.ceiling*.08)-(a.projection+a.ceiling*.08))
  const picked:Lineup[]=[];const exposure=new Map<string,number>()
  const max=Math.max(1,Math.ceil(s.lineupCount*s.maxExposure))
  for(const l of ranked){
    if(picked.length>=s.lineupCount)break
    if(picked.some(x=>!uniqueEnough(l,x,s.minUnique)))continue
    if(l.players.some(p=>(exposure.get(p.name)||0)>=max))continue
    picked.push(l);l.players.forEach(p=>exposure.set(p.name,(exposure.get(p.name)||0)+1))
  }
  return picked
}
