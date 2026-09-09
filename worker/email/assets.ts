// Expose only the two public brand images, never the private email templates.
export async function serveEmailAsset(request: Request, bucket: R2Bucket, context: ExecutionContext, cache: Cache = caches.default) {
  const url = new URL(request.url)
  const name = url.pathname.slice('/email-assets/'.length)
  if (!['header.png', 'footer.png'].includes(name)) return new Response('Not found', { status: 404 })
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
  const key = new Request(`${url.origin}${url.pathname}`)
  let response = await cache.match(key)
  if (!response) {
    const object = await bucket.get(`assets/${name}`)
    if (!object) return new Response('Not found', { status: 404 })
    response = new Response(object.body, { headers: {
      'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300',
      'ETag': object.httpEtag, 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    } })
    context.waitUntil(cache.put(key, response.clone()).catch(() => {}))
  }
  if (request.headers.get('If-None-Match') === response.headers.get('ETag')) return new Response(null, { status: 304, headers: response.headers })
  return request.method === 'HEAD' ? new Response(null, { headers: response.headers }) : response
}
