NFL DFS LAB - CLEAN REBUILD

Replace the old repository contents with the CONTENTS of this ZIP.

Required structure:
pages/
  +config.ts
  +Layout.tsx
  index/
    +Page.tsx
src/
public/
+server.ts
package.json
vite.config.ts
tsconfig.json
Dockerfile
render.yaml

Important fixes:
- pages/index/+Page.tsx included
- named Page export
- named Layout export
- ssr: false
- Render Docker config
- server error logging
- service-worker cache bumped

After GitHub commit/push, Render should redeploy automatically.
