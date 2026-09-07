import { timingSafeEqual } from 'node:crypto'
import type { AuthController } from './AuthController'
import type { OrganizationModel } from '../models/OrganizationModel'

const WINDOW_MS = 20 * 60 * 1000
const encode = (value: string) => new TextEncoder().encode(value)

export async function accessCode(secret: string, organizationId: string, window: number) {
  const key = await crypto.subtle.importKey('raw', encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, encode(`organization-join:${organizationId}:${window}`))
  return String(new DataView(signature).getUint32(0) % 10000).padStart(4, '0')
}

export class OrganizationController {
  private model: OrganizationModel
  private auth: AuthController
  private secret: string
  constructor(model: OrganizationModel, auth: AuthController, secret: string) {
    this.model = model; this.auth = auth; this.secret = secret
  }

  async handle(request: Request, trusted: boolean): Promise<Response> {
    const path = new URL(request.url).pathname
    const issuing = path === '/api/auth/organization-access/code'
    if (!issuing && path !== '/api/auth/organization-access/join') return new Response(null, { status: 404 })
    if (request.method !== (issuing ? 'GET' : 'POST')) return new Response(null, { status: 405 })
    if (!issuing && !trusted) return new Response(null, { status: 403 })
    const session = await this.auth.session(request)
    if (!session) return new Response(null, { status: 401 })
    if (!session.user.emailVerified) return new Response(null, { status: 403 })
    const window = Math.floor(Date.now() / WINDOW_MS)
    const headers = { 'cache-control': 'no-store' }
    if (issuing) {
      const org = await this.model.managedBy(session.user.id, session.session.activeOrganizationId ?? '')
      if (!org) return Response.json({ message: 'Só os proprietários e administradores podem consultar o código.' }, { status: 403, headers })
      return Response.json({ ...org, code: await accessCode(this.secret, org.id, window), expiresAt: (window + 1) * WINDOW_MS }, { headers })
    }
    // Count every attempt, including malformed bodies and unknown organizations.
    const allowed = await this.model.allowUserAttempt(session.user.id, request.headers.get('cf-connecting-ip'), window)
    const limited = () => Response.json({ message: 'Demasiadas tentativas. Tenta novamente quando o código mudar.' }, {
      status: 429, headers: { ...headers, 'retry-after': String(Math.ceil(((window + 1) * WINDOW_MS - Date.now()) / 1000)) },
    })
    if (!allowed) return limited()
    const body = await request.json().catch(() => null) as { name?: unknown; code?: unknown } | null
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    const code = typeof body?.code === 'string' ? body.code : ''
    const invalid = () => Response.json({ message: 'Organização ou código inválido. Confirma o identificador com um administrador.' }, { status: 400, headers })
    if (!name || name.length > 160 || !/^\d{4}$/.test(code)) return invalid()
    // A slug is unambiguous. A display name is accepted only if it resolves to one organization.
    const organizationId = await this.model.findUnambiguous(name)
    if (!organizationId) return invalid()
    if (!await this.model.allowOrganizationAttempt(organizationId, window)) return limited()
    const expected = await accessCode(this.secret, organizationId, window)
    if (!timingSafeEqual(encode(code), encode(expected))) return invalid()
    await this.model.join(session.user.id, organizationId)
    return Response.json({ organizationId }, { headers })
  }
}
