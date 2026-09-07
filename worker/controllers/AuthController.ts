import { createAuth, type Auth, type WorkerEnv } from '../auth'
import { ApiDocsView } from '../views/ApiDocsView'

export class AuthController {
  private auth: Auth
  constructor(env: WorkerEnv, context: ExecutionContext) {
    // Request-scoped: never retain an execution context or D1 binding globally.
    this.auth = createAuth(env, promise => context.waitUntil(promise))
  }

  session(request: Request) { return this.auth.api.getSession({ headers: request.headers }) }
  handle(request: Request) { return this.auth.handler(request) }

  async documentation(request: Request) {
    if (request.method !== 'GET') return new Response(null, { status: 405 })
    return Response.json(await ApiDocsView.schema(this.auth), { headers: { 'cache-control': 'public, max-age=60' } })
  }
}
