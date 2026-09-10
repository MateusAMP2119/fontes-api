import { betterAuth } from 'better-auth'
import { APIError } from 'better-auth/api'
import { OrganizationModel } from '../models/OrganizationModel'
import { jwt, organization, openAPI, emailOTP } from 'better-auth/plugins'
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

export class AuthController {
  private auth: ReturnType<typeof AuthController.createAuth>
  constructor(env: WorkerEnv, context: ExecutionContext) {
    // Request-scoped: never retain an execution context or D1 binding globally.
    this.auth = AuthController.createAuth(env, promise => context.waitUntil(promise))
  }

  session(request: Request) { return this.auth.api.getSession({ headers: request.headers }) }
  handle(request: Request) { return this.auth.handler(request) }
  setPassword(request: Request, newPassword: string) {
    return this.auth.api.setPassword({ headers: request.headers, body: { newPassword } })
  }

  async documentation(request: Request) {
    if (request.method !== 'GET') return new Response(null, { status: 405 })
    const generated = await this.auth.api.generateOpenAPISchema()
    const schema = { ...generated, info: custom.info, servers: [{ url: '/' }],
      paths: { ...Object.fromEntries(Object.entries(generated.paths).map(([path, operation]) => ['/api/auth' + path, operation])), ...custom.paths },
      components: { ...generated.components, securitySchemes: { ...generated.components.securitySchemes, ...custom.components.securitySchemes } },
    }
    return Response.json(schema, { headers: { 'cache-control': 'public, max-age=60' } })
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
          '/sign-up/email': { window: 60 * 60, max: 10 },
          '/request-password-reset': { window: 60 * 60, max: 5 },
          '/send-verification-email': { window: 60 * 60, max: 5 },
        },
      },
      plugins: [
        openAPI({ disableDefaultReference: true }),
        createOAuthProxy(baseURL, env.OAUTH_PROXY_SECRET),
        emailOTP({
          otpLength: 6, expiresIn: OTP_SECONDS, allowedAttempts: 5, storeOTP: 'hashed',
          async sendVerificationOTP({ email, otp, type }) {
            await sendTransactionalEmail(env, email, { kind: type, code: otp })
          },
        }),
        organization({
          organizationHooks: {
            beforeCreateOrganization: async ({ organization }) => {
              const name = organization.name?.trim()
              if (!name || name.length > 80) throw new APIError('BAD_REQUEST', { message: 'Nome inválido.' })
              return { data: { ...organization, name } }
            },
          },
        }),
        jwt({
          jwks: {
            jwksPath: '/.well-known/jwks.json',
            rotationInterval: 60 * 60 * 24 * 30,
            gracePeriod: 60 * 60 * 24 * 30,
          },
          jwt: {
            issuer: `${baseURL}/api/auth`,
            audience: 'authenticated',
            expirationTime: '15 minutes',
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
            before: async (user) => {
              if (user.username !== undefined && !AuthController.validUsername(user.username)) {
                throw new APIError('BAD_REQUEST', { message: 'Nome de utilizador inválido.' })
              }
              return { data: user }
            },
          },
        },
        session: {
          create: {
            // Resume the saved workspace if membership is still valid.
            before: async (session) => {
              const member = await new OrganizationModel(env.APP_DB).resumeFor(session.userId)
              return { data: { ...session, activeOrganizationId: member?.organizationId ?? null } }
            },
          },
        },
      },
      advanced: {
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
