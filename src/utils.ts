/**
 * Compile-time exhaustiveness check. Place in default branches of switches
 * over discriminated unions; TS will error if a new variant is added.
 */
export const unreachable = (x: never): never => {
  throw new Error(`Unreachable: ${JSON.stringify(x)}`)
}

/**
 * Wrap text in a fenced code block with the smallest fence length that
 * doesn't collide with any fence already inside the text. Fixes the case
 * where rendering a file that itself contains ``` would break the outer fence.
 */
export const markdownFence = (text: string, lang = ''): string => {
  let fence = '```'
  for (const m of text.matchAll(/^`{3,}/gm)) {
    while (m[0].length >= fence.length) fence += '`'
  }
  const trailing = text.endsWith('\n') ? '' : '\n'
  return `${fence}${lang}\n${text}${trailing}${fence}`
}
