import { Router } from 'express'
import type { Request, Response } from 'express'
import { estimateTokens } from '../translator.js'
import type { AnthropicRequest } from '../translator.js'
import { getAnthropicModelList, getAnthropicModelById } from '../kiro-models.js'

const createModelsRouter = (): Router => {
  const router = Router()

  router.get('/v1/models', (_req: Request, res: Response): void => {
    res.json({ object: 'list', data: getAnthropicModelList() })
  })

  router.get('/v1/models/:modelId', (req: Request, res: Response): void => {
    const modelId = req.params['modelId'] as string
    res.json(getAnthropicModelById(modelId))
  })

  router.post('/v1/messages/count_tokens', (req: Request, res: Response): void => {
    const body = req.body as Partial<AnthropicRequest>
    if (!body.messages || !Array.isArray(body.messages)) {
      res.status(400).json({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'messages: field required' },
      })
      return
    }
    let text = ''
    for (const msg of body.messages) {
      if (typeof msg.content === 'string') {
        text += msg.content
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') text += block.text
        }
      }
    }
    if (body.system) {
      text += typeof body.system === 'string'
        ? body.system
        : body.system.map((b) => b.text).join('\n')
    }
    res.json({ input_tokens: estimateTokens(text) })
  })

  return router
}

export default createModelsRouter
