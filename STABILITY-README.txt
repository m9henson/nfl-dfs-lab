NFL DFS LAB - STABILITY REBUILD

This package keeps Vike + React, but:
1. Uses Vike's official vike/fetch handler directly.
2. Does not use @vikejs/hono.
3. Disables service-worker caching temporarily.
4. Adds /diagnostic.
5. Adds request/response logging for every Vike page request.
6. Explicitly maps pages/index to route "/".

After deploying:
- Test https://YOUR-SITE.onrender.com/diagnostic
- Test https://YOUR-SITE.onrender.com/api/health
- Then test https://YOUR-SITE.onrender.com/

Once the home page is stable, service-worker/PWA offline caching can be added back.
