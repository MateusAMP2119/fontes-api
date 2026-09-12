import { defaultUsername } from '../username'
import { betterAuth } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { OrganizationModel } from '../models/OrganizationModel'
import { bearer, openAPI, emailOTP } from 'better-auth/plugins'
import custom from '../openapi.json'
import { createOAuthProxy } from '../oauth'
import { sendTransactionalEmail, OTP_SECONDS, RESET_SECONDS, VERIFICATION_SECONDS } from '../email/send'

type AuthSecrets = {
  BETTER_AUTH_SECRET: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  /** Canonical public origin; localhost uses the same routes and cookie flow. */
  BETTER_AUTH_URL?: string
  GOOGLE_REDIRECT_URI?: string
  OAUTH_PROXY_SECRET?: string
}

export type WorkerEnv = Omit<AuthBindings, 'BETTER_AUTH_URL' | 'GOOGLE_REDIRECT_URI'> & AuthSecrets

const BASE_URL = 'https://api.fonteslabs.com'
const TRUSTED_ORIGINS = [
  BASE_URL,
  'https://app.fonteslabs.com',
  'https://www.app.fonteslabs.com',
  'https://builder.fonteslabs.com',
  'https://fontes-9lo.pages.dev',
  'https://*.fontes-9lo.pages.dev',
  'http://localhost:5173',
]

function trustedOrigins(env: WorkerEnv) {
  return env.BETTER_AUTH_URL && !TRUSTED_ORIGINS.includes(env.BETTER_AUTH_URL)
    ? [...TRUSTED_ORIGINS, env.BETTER_AUTH_URL]
    : TRUSTED_ORIGINS
}

// Pin the browser bundle so local and deployed docs use the same Scalar release.
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fontes App API · Scalar</title>
<style>body{margin:0}</style>
</head><body>
<div id="app"></div>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.67.0/dist/browser/standalone.js"></script>
<script>Scalar.createApiReference('#app', {
  url: '/api/auth/openapi.json',
  theme: 'default',
  hideClientButton: false,
  showDeveloperTools: 'never',
  persistAuth: false,
  telemetry: false,
  proxyUrl: '',
  customFetch: (input, init) => fetch(input, { ...init, credentials: 'same-origin' })
})</script>
</body></html>`

// Public auth surface used by the app, including redirects from Google and email.
const GET_PATHS = new Set([
  '/api/auth/get-session', '/api/auth/callback/google', '/api/auth/oauth-proxy-callback',
  '/api/auth/verify-email', '/api/auth/error',
])
const POST_PATHS = new Set([
  '/api/auth/sign-in/social', '/api/auth/sign-in/email', '/api/auth/sign-in/email-otp',
  '/api/auth/email-otp/send-verification-otp', '/api/auth/sign-out',
  '/api/auth/set-password', '/api/auth/reset-password', '/api/auth/request-password-reset',
])

export class AuthController {
  private auth: ReturnType<typeof AuthController.createAuth>
  constructor(private env: WorkerEnv, context: ExecutionContext) {
    // Request-scoped: never retain an execution context or D1 binding globally.
    this.auth = AuthController.createAuth(env, promise => context.waitUntil(promise))
  }

  session(request: Request) { return this.auth.api.getSession({ headers: request.headers }) }
  bearerSession(request: Request) {
    if (!/^Bearer\s+\S+$/i.test(request.headers.get('authorization') ?? '')) return Promise.resolve(null)
    const headers = new Headers(request.headers)
    // An invalid bearer token must never fall back to a browser session cookie.
    headers.delete('cookie')
    return this.auth.api.getSession({ headers })
  }

  static publicMethod(path: string): 'GET' | 'POST' | undefined {
    if (GET_PATHS.has(path)) return 'GET'
    if (POST_PATHS.has(path)) return 'POST'
    if (/^\/api\/auth\/reset-password\/[^/]+$/.test(path)) return 'GET'
  }

  async handle(request: Request) {
    const path = new URL(request.url).pathname
    const method = AuthController.publicMethod(path)
    if (!method) return new Response(null, { status: 404 })
    if (request.method !== method) return new Response(null, { status: 405, headers: { Allow: method } })
    if (path === '/api/auth/set-password') {
      const origin = request.headers.get('origin')
      if (origin ? !AuthController.isTrustedOrigin(origin, this.env) : !/^Bearer\s+\S+$/i.test(request.headers.get('authorization') ?? '')) return new Response(null, { status: 403 })
      const session = await this.session(request)
      if (!session?.user.emailVerified) return Response.json({ message: 'Confirmação de email necessária.' }, { status: 401 })
      let body
      try { body = await request.json() as Record<string, unknown> } catch { return new Response(null, { status: 400 }) }
      if (!body || typeof body.password !== 'string' || typeof body['new-password'] !== 'string') return Response.json({ message: 'Palavra-passe atual e nova obrigatórias.' }, { status: 400 })
      if (body.password === '') {
        const created = new Date(session.session.createdAt).getTime()
        if (!Number.isFinite(created) || Date.now() - created > 15 * 60 * 1000) return Response.json({ message: 'Nova autenticação necessária.', step: 'email' }, { status: 401 })
        const setup = await this.auth.api.setPassword({ headers: request.headers, body: { newPassword: body['new-password'] }, asResponse: true })
        if (!setup.ok) return setup
      }
      const url = new URL(request.url)
      url.pathname = '/api/auth/change-password'
      const change = { currentPassword: body.password || body['new-password'], newPassword: body['new-password'], revokeOtherSessions: true }
      // Initial setup has already passed authentication and freshness checks.
      const response = body.password === ''
        ? await this.auth.api.changePassword({ headers: request.headers, body: change, asResponse: true })
        : await this.auth.handler(new Request(url, { method: 'POST', headers: request.headers, body: JSON.stringify(change) }))
      if (!response.ok) return response
      const result = await response.json() as { token: string; user: unknown }
      const refreshed = await this.auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${result.token}` }) })
      return Response.json({ ...result, session: refreshed?.session }, { headers: response.headers })
    }
    return this.auth.handler(request)
  }
  setPassword(request: Request, newPassword: string) {
    return this.auth.api.setPassword({ headers: request.headers, body: { newPassword } })
  }

  async documentation(request: Request) {
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } })
    const generated = await this.auth.api.generateOpenAPISchema()
    const paths = Object.fromEntries(Object.entries(generated.paths).flatMap(([path, operations]) => {
      const fullPath = '/api/auth' + (path === '/change-password' ? '/set-password' : path)
      const method = AuthController.publicMethod(fullPath.replace('{id}', 'google'))?.toLowerCase()
      if (!method || !(method in operations)) return []
      const operation = operations[method as keyof typeof operations]
      if (!operation) return []
      const security: Record<string, string[]>[] = ['/get-session', '/sign-out', '/change-password'].includes(path)
        ? [{ sessionBearer: [] }, { sessionCookie: [] }, { secureSessionCookie: [] }]
        : []
      if (path === '/get-session') security.push({})
      const labels: Record<string, string> = {
        '/email-otp/send-verification-otp': 'Send registration code',
        '/sign-in/email-otp': 'Verify registration code',
        '/sign-in/email': 'Log in account',
        '/get-session': 'Read current session',
        '/change-password': 'Set password',
      }
      const codePurpose = operation.requestBody?.content?.['application/json']?.schema?.properties?.type
      if (path === '/email-otp/send-verification-otp' && codePurpose) {
        codePurpose.enum = ['sign-in']
        codePurpose.description = 'Registration code purpose.'
      }
      if (path === '/email-otp/send-verification-otp') operation.description = 'Sends a six-digit code for a new account, valid for 10 minutes.'
      if (path === '/sign-in/email-otp') operation.description = 'Verifies a new account and returns its first session token. Existing accounts use password or Google.'
      if (path === '/sign-in/email') operation.description = 'Returns a session token for an existing account.'
      if (path === '/change-password') {
        const schema = operation.requestBody?.content?.['application/json']?.schema
        if (schema?.properties) {
          schema.properties.password = schema.properties.currentPassword
          schema.properties['new-password'] = schema.properties.newPassword
          delete schema.properties.currentPassword
          delete schema.properties.newPassword
          delete schema.properties.revokeOtherSessions
          schema.required = schema.required?.map(name => name === 'currentPassword' ? 'password' : name === 'newPassword' ? 'new-password' : name).filter(name => name !== 'revokeOtherSessions')
        }
        const responseSchema = operation.responses?.['200']?.content?.['application/json']?.schema
        const sessionSchema = generated.paths['/get-session']?.get?.responses?.['200']?.content?.['application/json']?.schema?.properties?.session
        if (responseSchema?.properties) {
          responseSchema.properties.token = { type: 'string', description: 'Replacement session token.' }
          if (sessionSchema) responseSchema.properties.session = sessionSchema
          responseSchema.required = ['token', 'session', 'user']
        }
        operation.description = 'Requires a verified session and password. Use an empty string only when no password exists. Replaces all sessions and returns the new token, session and user.'
      }
      if (path === '/get-session') operation.description = 'Returns the current session and user, or null.'
      operation.tags = [path === '/verify-email' ? 'Email verification' : 'Authentication']
      if (path === '/sign-in/social') {
        operation.description = 'Starts Google sign-in. callbackURL is the return address, e.g. https://app.fonteslabs.com/.'
      }
      if (path === '/callback/{id}' && operation.parameters) {
        operation.parameters = operation.parameters.filter(parameter => parameter.in !== 'path' || parameter.name !== 'id')
      }
      return [[fullPath.replace('{id}', 'google'), { [method]: { ...operation, security, ...(labels[path] ? { summary: labels[path] } : {}) } }]]
    }))
    return Response.json({ ...generated, info: custom.info, servers: [{ url: '/' }], security: [],
      tags: [...['Authentication', 'Email verification'].map(name => ({ name })), ...custom.tags],
      paths: { ...paths, ...custom.paths },
      components: { ...generated.components, securitySchemes: custom.components.securitySchemes },
    })
  }

  static page(request: Request): Response {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } })
    return new Response(request.method === 'HEAD' ? null : html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      },
    })
  }

  static isTrustedOrigin(origin: string | null, env: WorkerEnv) {
    if (!origin) return false
    return trustedOrigins(env).some((pattern) =>
      pattern.includes('*')
        ? new RegExp(`^${pattern.replaceAll('.', '\\.').replace('*', '[a-z0-9-]+')}$`).test(origin)
        : pattern === origin,
    )
  }

  private static validUsername(value: unknown): value is string {
    return typeof value === 'string' && /^[a-z0-9_]{3,30}$/.test(value)
  }

  private static createAuth(env: WorkerEnv, waitUntil: (promise: Promise<unknown>) => void) {
    const baseURL = env.BETTER_AUTH_URL ?? BASE_URL
    const newRegistrations = new Set<string>()
    const existingAccount = () => new APIError('BAD_REQUEST', { code: 'REGISTRATION_ACCOUNT_EXISTS', message: 'Email já registado. Início de sessão com palavra-passe ou Google; recuperação de acesso disponível.' })
    return betterAuth({
      appName: 'Fontes',
      baseURL,
      basePath: '/api/auth',
      secret: env.BETTER_AUTH_SECRET,
      database: env.APP_DB,
      trustedOrigins: trustedOrigins(env),
      user: {
        additionalFields: {
          username: { type: 'string', required: false, unique: true },
        },
      },
      session: {
        additionalFields: {
          activeOrganizationId: { type: 'string', required: false, input: false },
        },
      },
      emailAndPassword: {
        enabled: true,
        requireEmailVerification: true,
        minPasswordLength: 8,
        resetPasswordTokenExpiresIn: RESET_SECONDS,
        revokeSessionsOnPasswordReset: true,
        sendResetPassword: async ({ user, url }) => {
          await sendTransactionalEmail(env, user.email, { kind: 'reset-link', url })
        },
      },
      emailVerification: {
        sendOnSignUp: true,
        autoSignInAfterVerification: true,
        expiresIn: VERIFICATION_SECONDS,
        sendVerificationEmail: async ({ user, url }) => {
          await sendTransactionalEmail(env, user.email, { kind: 'verify-link', url })
        },
      },
      socialProviders: {
        google: {
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
          redirectURI: env.GOOGLE_REDIRECT_URI,
          requireEmailVerification: true,
        },
      },
      rateLimit: {
        enabled: true,
        storage: 'database',
        window: 60,
        max: 100,
        customRules: {
          '/email-otp/send-verification-otp': { window: 60, max: 3 },
          '/sign-in/email-otp': { window: 60, max: 10 },
          '/sign-in/email': { window: 60, max: 10 },
          '/request-password-reset': { window: 60 * 60, max: 5 },
        },
      },
      hooks: {
        before: createAuthMiddleware(async ctx => {
          if (!['/email-otp/send-verification-otp', '/sign-in/email-otp'].includes(ctx.path ?? '')) return
          if (ctx.path === '/email-otp/send-verification-otp' && ctx.body?.type !== 'sign-in') {
            throw new APIError('BAD_REQUEST', { code: 'REGISTRATION_CODE_ONLY', message: 'Código disponível apenas para registo.' })
          }
          const email = typeof ctx.body?.email === 'string' ? ctx.body.email.toLowerCase() : ''
          if (email && await ctx.context.internalAdapter.findUserByEmail(email)) throw existingAccount()
        }),
      },
      plugins: [
        bearer(),
        openAPI({ disableDefaultReference: true }),
        createOAuthProxy(baseURL, env.OAUTH_PROXY_SECRET),
        emailOTP({
          otpLength: 6, expiresIn: OTP_SECONDS, allowedAttempts: 5, storeOTP: 'hashed',
          async sendVerificationOTP({ email, otp, type }) {
            await sendTransactionalEmail(env, email, { kind: type, code: otp })
          },
        }),
      ],
      databaseHooks: {
        user: {
          update: {
            before: async (user) => {
              if (user.username === undefined) return
              if (!AuthController.validUsername(user.username)) throw new APIError('BAD_REQUEST', { message: 'Nome de utilizador inválido.' })
              return { data: user }
            },
          },
          create: {
            after: async (user, ctx) => {
              if (ctx?.path === '/sign-in/email-otp') newRegistrations.add(user.id)
            },
            before: async (user, ctx) => {
              if (user.username !== undefined && !AuthController.validUsername(user.username)) {
                throw new APIError('BAD_REQUEST', { message: 'Nome de utilizador inválido.' })
              }
              if (!ctx) return { data: user }
              const username = user.username ?? await defaultUsername(user.name, user.email, async value => !!await ctx.context.adapter.findOne({ model: 'user', where: [{ field: 'username', value }] }))
              return { data: { ...user, username } }
            },
          },
        },
        session: {
          create: {
            // Resume the saved workspace if membership is still valid.
            before: async (session, ctx) => {
              // Only the account created by this registration may receive an OTP session.
              // Also rejects an account created concurrently after the initial lookup.
              if (ctx?.path === '/sign-in/email-otp' && !newRegistrations.delete(session.userId)) throw existingAccount()
              const member = await new OrganizationModel(env.APP_DB).resumeFor(session.userId)
              return { data: { ...session, activeOrganizationId: member?.organizationId ?? null } }
            },
          },
        },
      },
      advanced: {
        ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
        backgroundTasks: { handler: waitUntil },
        defaultCookieAttributes: {
          // Safari drops Secure cookies over plain http://localhost, so follow the base URL's scheme.
          secure: baseURL.startsWith('https://'),
          httpOnly: true,
          sameSite: 'lax',
        },
      },
    })
  }
}
