import { ApiController } from './controllers/ApiController'
import type { WorkerEnv } from './auth'

export default {
  fetch(request: Request, env: WorkerEnv, context: ExecutionContext): Promise<Response> {
    return new ApiController(env, context).handle(request)
  },
} satisfies ExportedHandler<WorkerEnv>
