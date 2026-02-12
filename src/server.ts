import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { resolveOrgId } from './auth.js'
import { registerDashboardTools } from './tools/dashboard.js'
import { registerFinanceiroTools } from './tools/financeiro.js'
import { registerOrcamentosTools } from './tools/orcamentos.js'
import { registerAgendamentosTools } from './tools/agendamentos.js'
import { registerMetasTools } from './tools/metas.js'
import { registerClientesTools } from './tools/clientes.js'
import { registerFiscalTools } from './tools/fiscal.js'

/**
 * Cria o McpServer com todas as tools registradas.
 *
 * Modo STDIO: não passa apiKey/orgIdOverride, resolve de process.env
 * Modo HTTP:  passa apiKey (Bearer token) e orgIdOverride (X-Org-Id header)
 */
export async function createServer(apiKey?: string, orgIdOverride?: string): Promise<McpServer> {
  const orgId = await resolveOrgId(apiKey, orgIdOverride)

  const server = new McpServer({
    name: 'gv-gestao-a-vista',
    version: '1.0.0',
  })

  // Registrar tools de cada módulo
  registerDashboardTools(server, orgId)
  registerFinanceiroTools(server, orgId)
  registerOrcamentosTools(server, orgId)
  registerAgendamentosTools(server, orgId)
  registerMetasTools(server, orgId)
  registerClientesTools(server, orgId)
  registerFiscalTools(server, orgId)

  return server
}
