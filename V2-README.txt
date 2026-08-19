NFL DFS LAB V2 RELIABLE
1 Import/fetch DraftKings slate.
2 Choose season/week.
3 Tap Prepare Week — automatic.
4 Review players.
5 Generate lineups.

Major change: data merging and lineup generation now run on Render, not the iPhone.
DraftKings CSV is the recommended source of truth for salaries/player IDs.
nflverse weekly history and Sleeper status are optional enrichments; failure of either does not block the slate.
The optimizer uses bounded branch-and-bound search with a 7-second deadline instead of thousands of random browser loops.
