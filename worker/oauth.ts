/** Preserve Google's registered callback while completing auth on the API host. */
export function oauthCallbackRedirect(request: Request, apiOrigin: string, registeredCallback?: string): Response | undefined {
  if (request.method !== 'GET' || !registeredCallback) return
  const incoming = new URL(request.url)
  const registered = new URL(registeredCallback)
  const destination = new URL('/api/auth/callback/google', apiOrigin)
  if (incoming.origin !== registered.origin || incoming.pathname !== registered.pathname || incoming.origin === destination.origin) return
  destination.search = incoming.search
  return new Response(null, {
    status: 302,
    headers: { Location: destination.href, 'Referrer-Policy': 'no-referrer' },
  })
}
