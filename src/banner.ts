import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const CYAN = '\x1b[36m'
const YELLOW = '\x1b[33m'
const GREEN = '\x1b[32m'
const MAGENTA = '\x1b[35m'

const printBanner = (port: number, poolSize: number): void => {
  const url = `http://localhost:${port}`
  const art = `
${MAGENTA}${BOLD}
  ██╗  ██╗██╗██████╗  █████╗ ██╗   ██╗██████╗ ███████╗
  ██║ ██╔╝██║██╔══██╗██╔══██╗██║   ██║██╔══██╗██╔════╝
  █████╔╝ ██║██████╔╝███████║██║   ██║██║  ██║█████╗
  ██╔═██╗ ██║██╔══██╗██╔══██║██║   ██║██║  ██║██╔══╝
  ██║  ██╗██║██║  ██║██║  ██║╚██████╔╝██████╔╝███████╗
  ╚═╝  ╚═╝╚═╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝
${RESET}
  ${DIM}Anthropic API proxy → Kiro CLI via ACP${RESET}
  ${DIM}v${version}${RESET}

  ${CYAN}▸${RESET} ${BOLD}Server${RESET}    ${GREEN}${url}${RESET}
  ${CYAN}▸${RESET} ${BOLD}Workers${RESET}   ${YELLOW}${poolSize}${RESET}

  ${DIM}Connect Claude Code:${RESET}
  ${CYAN}ANTHROPIC_BASE_URL=${url} ANTHROPIC_API_KEY=sk-ant-dumy claude${RESET}
`
  console.log(art)
}

export { printBanner, version }
