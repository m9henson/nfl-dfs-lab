import React, { type ReactNode } from 'react'

export function Layout({ children }: { children: ReactNode }) {

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="ball">◉</span>
          <div>
            <h1>NFL DFS Lab</h1>
            <div className="muted">NFL research · projections · stacks · DraftKings lineups</div>
          </div>
        </div>
      </header>
      {children}
    </>
  )
}
