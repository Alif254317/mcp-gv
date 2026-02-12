import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getSupabase } from '../supabase.js'

export function registerClientesTools(server: McpServer, orgId: string | null) {
  // ── Tool 1: Listar clientes ──
  server.tool(
    'list_clientes',
    'Lista clientes cadastrados com busca por nome e paginação',
    {
      busca: z.string().optional().describe('Busca por nome, email, telefone ou CPF/CNPJ (parcial)'),
      page: z.number().min(1).default(1),
      limit: z.number().min(1).max(100).default(20),
    },
    async ({ busca, page, limit }) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()
      let query = supabase
        .from('clientes')
        .select('*', { count: 'exact' })
        .eq('organization_id', orgId)

      if (busca) {
        query = query.or(`nome.ilike.%${busca}%,email.ilike.%${busca}%,telefone.ilike.%${busca}%,cpf_cnpj.ilike.%${busca}%`)
      }

      const from = (page - 1) * limit
      const { data, count, error } = await query
        .order('nome', { ascending: true })
        .range(from, from + limit - 1)

      if (error) return { content: [{ type: 'text' as const, text: `Erro: ${error.message}` }] }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ data: data || [], total: count ?? 0, page, limit }) }] }
    }
  )

  // ── Tool 2: Identificar cliente por email ou telefone ──
  server.tool(
    'identify_cliente',
    'Identifica um cliente pelo email ou telefone. Retorna os dados se encontrado.',
    {
      phone: z.string().optional().describe('Telefone do cliente'),
      email: z.string().optional().describe('Email do cliente'),
    },
    async ({ phone, email }) => {
      if (!phone && !email) {
        return { content: [{ type: 'text' as const, text: 'Erro: informe ao menos phone ou email' }] }
      }

      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()
      let query = supabase
        .from('clientes')
        .select('id, organization_id, nome, telefone, email')
        .eq('organization_id', orgId)

      if (phone) query = query.eq('telefone', phone.trim())
      if (email) query = query.eq('email', email.trim())

      const { data, error } = await query.maybeSingle()

      if (error) return { content: [{ type: 'text' as const, text: `Erro: ${error.message}` }] }

      if (!data) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ found: false }) }] }
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ found: true, cliente: data }) }] }
    }
  )
}
