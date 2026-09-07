import { betterAuth } from 'better-auth'
import { APIError } from 'better-auth/api'
import { validUsername } from './onboarding-validation'
import { EmailView } from './views/EmailView'
import { OrganizationModel } from './models/OrganizationModel'
import { jwt, organization, openAPI } from 'better-auth/plugins'

type AuthSecrets = {
  BETTER_AUTH_SECRET: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  /** Canonical public origin; localhost uses the same routes and cookie flow. */
  BETTER_AUTH_URL?: string
}

export type WorkerEnv = Omit<AuthBindings, 'BETTER_AUTH_URL'> & AuthSecrets

const FROM = { email: 'conta@fonteslabs.com', name: 'Fontes' }

const BASE_URL = 'https://builder.fonteslabs.com'
const TRUSTED_ORIGINS = [BASE_URL, 'https://fontes-9lo.pages.dev', 'https://*.fontes-9lo.pages.dev']

function trustedOrigins(env: WorkerEnv) {
  return env.BETTER_AUTH_URL && !TRUSTED_ORIGINS.includes(env.BETTER_AUTH_URL)
    ? [...TRUSTED_ORIGINS, env.BETTER_AUTH_URL]
    : TRUSTED_ORIGINS
}

export function isTrustedOrigin(origin: string | null, env: WorkerEnv) {
  if (!origin) return false
  return trustedOrigins(env).some((pattern) =>
    pattern.includes('*')
      ? new RegExp(`^${pattern.replaceAll('.', '\\.').replace('*', '[a-z0-9-]+')}$`).test(origin)
      : pattern === origin,
  )
}

export function createAuth(env: WorkerEnv, waitUntil: (promise: Promise<unknown>) => void) {
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
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await env.AUTH_EMAIL.send({
          to: user.email,
          from: FROM,
          subject: 'Recupera a tua palavra-passe — Fontes',
          html: EmailView.render(
            'Recuperar palavra-passe',
            'Recebemos um pedido para definires uma nova palavra-passe na tua conta.',
            'Definir nova palavra-passe',
            url,
          ),
          text: url,
        })
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60 * 24,
      sendVerificationEmail: async ({ user, url }) => {
        await env.AUTH_EMAIL.send({
          to: user.email,
          from: FROM,
          subject: 'Confirma a tua conta — Fontes',
          html: EmailView.render(
            'Confirma o teu email',
            'Só falta confirmares este endereço para começares a usar a tua conta Fontes.',
            'Confirmar conta',
            url,
          ),
          text: url,
        })
      },
    },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        requireEmailVerification: true,
      },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/sign-up/email': { window: 60 * 60, max: 10 },
        '/request-password-reset': { window: 60 * 60, max: 5 },
        '/send-verification-email': { window: 60 * 60, max: 5 },
      },
    },
    plugins: [
      openAPI({ disableDefaultReference: true }),
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
            if (!validUsername(user.username)) throw new APIError('BAD_REQUEST', { message: 'Nome de utilizador inválido.' })
            return { data: user }
          },
        },
        create: {
          before: async (user) => {
            if (user.username !== undefined && !validUsername(user.username)) {
              throw new APIError('BAD_REQUEST', { message: 'Nome de utilizador inválido.' })
            }
            return { data: user }
          },
        },
      },
      session: {
        create: {
          // A new session resumes the user's first organization, so the client derives
          // onboarding from data instead of from the URL it signed in on.
          before: async (session) => {
            const member = await new OrganizationModel(env.APP_DB).firstFor(session.userId)
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

export type Auth = ReturnType<typeof createAuth>
