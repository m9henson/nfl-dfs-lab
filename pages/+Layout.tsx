import React, { type ReactNode, useEffect } from 'react'
import '../src/styles.css'

export function Layout({ children }: { children: ReactNode }) {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/sw.js')
        .catch(() => undefined)
    }
  }, [])

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="ball">◉</span>

          <div>
            <h1>NFL DFS Lab</h1>
            <div className="muted">
              NFL research · projections · stacks · DraftKings lineups
            </div>
          </div>
        </div>
      </header>

      {children}
    </>
  )
}
