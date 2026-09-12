import { betterAuth } from 'better-auth'
import { APIError } from 'better-auth/api'
import { OrganizationModel } from '../models/OrganizationModel'
import { emailOTP } from 'better-auth/plugins'
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

// Public auth surface used by the app, including redirects from Google and email.
const GET_PATHS = new Set([
  '/api/auth/get-session', '/api/auth/callback/google', '/api/auth/oauth-proxy-callback',
  '/api/auth/verify-email', '/api/auth/error',
])
const POST_PATHS = new Set([
  '/api/auth/sign-in/social', '/api/auth/sign-in/email', '/api/auth/sign-in/email-otp',
  '/api/auth/email-otp/send-verification-otp', '/api/auth/sign-out',
  '/api/auth/change-password', '/api/auth/reset-password', '/api/auth/request-password-reset',
])

export class AuthController {
  private auth: ReturnType<typeof AuthController.createAuth>
  constructor(env: WorkerEnv, context: ExecutionContext) {
    // Request-scoped: never retain an execution context or D1 binding globally.
    this.auth = AuthController.createAuth(env, promise => context.waitUntil(promise))
  }

  session(request: Request) { return this.auth.api.getSession({ headers: request.headers }) }
  static publicMethod(path: string): 'GET' | 'POST' | undefined {
    if (GET_PATHS.has(path)) return 'GET'
    if (POST_PATHS.has(path)) return 'POST'
    if (/^\/api\/auth\/reset-password\/[^/]+$/.test(path)) return 'GET'
  }

  handle(request: Request) {
    const path = new URL(request.url).pathname
    const method = AuthController.publicMethod(path)
    if (!method) return new Response(null, { status: 404 })
    if (request.method !== method) return new Response(null, { status: 405, headers: { Allow: method } })
    return this.auth.handler(request)
  }
  setPassword(request: Request, newPassword: string) {
    return this.auth.api.setPassword({ headers: request.headers, body: { newPassword } })
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
      plugins: [
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
