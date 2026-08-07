const CACHE='nfl-dfs-lab-shell-v3'
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(['/','/manifest.webmanifest','/icon.svg'])))
})
self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))))
})
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url)
  if(event.request.method!=='GET'||url.pathname.startsWith('/api/')) return
  event.respondWith(fetch(event.request).then(response=>{
    const copy=response.clone()
    caches.open(CACHE).then(cache=>cache.put(event.request,copy))
    return response
  }).catch(()=>caches.match(event.request).then(hit=>hit||caches.match('/'))))
})
