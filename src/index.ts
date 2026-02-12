#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'

async function main() {
  const server = await createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('GV MCP Server running on stdio')
}

main().catch((err) => {
  console.error('Falha ao iniciar GV MCP Server:', err)
  process.exit(1)
})
