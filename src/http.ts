#!/usr/bin/env node
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer } from './server.js'

const PORT = parseInt(process.env.PORT || '3100', 10)

/**
 * Extrai o Bearer token do header Authorization.
 */
function extractBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return null
  return auth.slice(7).trim() || null
}

/**
 * Lê o body JSON de um request.
 */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8')
        resolve(raw ? JSON.parse(raw) : undefined)
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

/**
 * Mapa de sessões ativas: sessionId -> { transport, server }
 * Cada sessão MCP pertence a um tenant (org) com base no token de auth.
 */
const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Awaited<ReturnType<typeof createServer>> }>()

/**
 * Handler principal para requests MCP no path /mcp
 */
async function handleMcpRequest(req: IncomingMessage, res: ServerResponse) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, X-Org-Id')
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // ── POST: mensagens JSON-RPC (initialize, tools/call, etc.) ──
  if (req.method === 'POST') {
    const body = await readBody(req)

    // Verificar se é initialize (nova sessão)
    const isInit = Array.isArray(body)
      ? body.some((m: any) => m.method === 'initialize')
      : (body as any)?.method === 'initialize'

    if (isInit) {
      // Nova sessão: autenticar via Bearer token + X-Org-Id opcional
      const apiKey = extractBearerToken(req)
      if (!apiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Authorization header com Bearer token é obrigatório' }))
        return
      }
      const orgIdHeader = (req.headers['x-org-id'] as string)?.trim() || undefined

      let mcpServer: Awaited<ReturnType<typeof createServer>>
      try {
        mcpServer = await createServer(apiKey, orgIdHeader)
      } catch (err: any) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
        return
      }

      const sessionId = randomUUID()
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
      })

      transport.onclose = () => {
        sessions.delete(sessionId)
        console.error(`[http] Sessão encerrada: ${sessionId}`)
      }

      await mcpServer.connect(transport)

      // Registrar sessão ANTES do handleRequest para que esteja disponível
      sessions.set(sessionId, { transport, server: mcpServer })
      console.error(`[http] Nova sessão: ${sessionId}`)

      await transport.handleRequest(req, res, body)
      return
    }

    // Request subsequente: buscar sessão existente
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Sessão inválida ou expirada. Envie initialize primeiro.' }))
      return
    }

    const session = sessions.get(sessionId)!
    await session.transport.handleRequest(req, res, body)
    return
  }

  // ── GET: SSE stream para notificações server->client ──
  if (req.method === 'GET') {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Sessão inválida' }))
      return
    }

    const session = sessions.get(sessionId)!
    await session.transport.handleRequest(req, res)
    return
  }

  // ── DELETE: encerrar sessão ──
  if (req.method === 'DELETE') {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!
      await session.transport.handleRequest(req, res)
      sessions.delete(sessionId)
    } else {
      res.writeHead(200)
      res.end()
    }
    return
  }

  res.writeHead(405, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Method not allowed' }))
}

// ── Criar servidor HTTP ──
const httpServer = createHttpServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`)

  // Health check
  if (url.pathname === '/health' || url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'ok',
      server: 'gv-gestao-a-vista',
      version: '1.0.1',
      sessions: sessions.size,
      env: {
        SUPABASE_URL: process.env.SUPABASE_URL ? 'set' : 'missing',
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ? 'set' : 'missing',
        MASTER_API_KEY: process.env.MASTER_API_KEY ? 'set' : 'missing',
        PORT: process.env.PORT || 'default',
      }
    }))
    return
  }

  // MCP endpoint
  if (url.pathname === '/mcp') {
    try {
      await handleMcpRequest(req, res)
    } catch (err: any) {
      console.error('[http] Erro:', err.message)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Erro interno do servidor' }))
      }
    }
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found. Use /mcp para MCP ou /health para status.' }))
})

httpServer.listen(PORT, '0.0.0.0', () => {
  console.error(`[http] GV MCP Server HTTP rodando em http://0.0.0.0:${PORT}/mcp`)
  console.error(`[http] Health check: http://localhost:${PORT}/health`)
})
