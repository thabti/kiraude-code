import { Router } from 'express'
import type { Request, Response } from 'express'
import { getAnthropicModelList } from '../kiro-models.js'

const createBootstrapRouter = (): Router => {
  const router = Router()

  router.get('/api/claude_cli/bootstrap', (_req: Request, res: Response): void => {
    const models = getAnthropicModelList()
    const additionalModelOptions = models.map((m) => ({
      model: m.id,
      name: m.description ?? m.id,
      description: `Kiro-powered ${m.id}`,
    }))
    res.json({
      additional_model_options: additionalModelOptions,
      client_data: {},
    })
  })

  return router
}

export default createBootstrapRouter
