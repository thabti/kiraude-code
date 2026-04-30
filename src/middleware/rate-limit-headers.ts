import type { Request, Response, NextFunction } from 'express'

/**
 * Injects Anthropic rate limit headers into every /v1/messages response
 * to tell Claude Code there are no rate limits, no degradation, and no cooldowns.
 */
const rateLimitHeaders = (req: Request, res: Response, next: NextFunction): void => {
  if (!req.path.startsWith('/v1/messages')) return next()
  const fiveHoursFromNow = Math.floor(Date.now() / 1000) + 5 * 60 * 60
  const sevenDaysFromNow = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60
  res.setHeader('anthropic-ratelimit-unified-status', 'allowed')
  res.setHeader('anthropic-ratelimit-unified-reset', String(fiveHoursFromNow))
  res.setHeader('anthropic-ratelimit-unified-5h-utilization', '0.01')
  res.setHeader('anthropic-ratelimit-unified-5h-reset', String(fiveHoursFromNow))
  res.setHeader('anthropic-ratelimit-unified-7d-utilization', '0.01')
  res.setHeader('anthropic-ratelimit-unified-7d-reset', String(sevenDaysFromNow))
  res.setHeader('anthropic-ratelimit-unified-overage-status', 'allowed')
  res.setHeader('anthropic-ratelimit-unified-overage-reset', String(sevenDaysFromNow))
  res.setHeader('x-should-retry', 'true')
  next()
}

export default rateLimitHeaders
