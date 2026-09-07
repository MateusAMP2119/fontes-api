const METHODS = ['GET', 'HEAD', 'POST', 'OPTIONS']
const HEADERS = ['content-type', 'authorization']

/** Handle preflight before invoking auth or touching D1. */
export function preflight(request: Request, trusted: boolean): Response | undefined {
  if (request.method !== 'OPTIONS') return
  const method = request.headers.get('Access-Control-Request-Method') ?? ''
  const headers = (request.headers.get('Access-Control-Request-Headers') ?? '')
    .split(',').map(header => header.trim().toLowerCase()).filter(Boolean)
  if (!trusted || !METHODS.includes(method) || headers.some(header => !HEADERS.includes(header))) {
    return new Response(null, { status: 403 })
  }
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': METHODS.join(', '),
      'Access-Control-Allow-Headers': HEADERS.join(', '),
      'Access-Control-Max-Age': '600',
    },
  })
}

export function withCors(result: Response, origin: string | null, trusted: boolean): Response {
  const response = new Response(result.body, result)
  response.headers.append('Vary', 'Origin')
  if (origin && trusted) {
    response.headers.set('Access-Control-Allow-Origin', origin)
    response.headers.set('Access-Control-Allow-Credentials', 'true')
    response.headers.set('Access-Control-Expose-Headers', 'set-auth-token')
  }
  return response
}
