import { ApiController } from './controllers/ApiController'
import type { WorkerEnv } from './controllers/AuthController'

export default {
  async fetch(request: Request, env: WorkerEnv, context: ExecutionContext): Promise<Response> {
    const result = await new ApiController(env, context).handle(request)
    const response = new Response(result.body, result)
    // Auth and workspace responses depend on the current user's cookies.
    response.headers.set('Cache-Control', 'private, no-store')
    response.headers.set('Cloudflare-CDN-Cache-Control', 'no-store')
    return response
  },
} satisfies ExportedHandler<WorkerEnv>
