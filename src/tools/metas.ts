import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getSupabase } from '../supabase.js'

export function registerMetasTools(server: McpServer, orgId: string | null) {
  // ── Tool 1: Listar metas ──
  server.tool(
    'list_metas',
    'Lista metas de vendas mensais (últimos N meses)',
    {
      limit: z.number().min(1).max(48).default(12).describe('Quantidade de meses a retornar'),
    },
    async ({ limit }) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()
      const { data, count, error } = await supabase
        .from('metas')
        .select('*', { count: 'exact' })
        .eq('organization_id', orgId)
        .order('mes', { ascending: false })
        .limit(limit)

      if (error) return { content: [{ type: 'text' as const, text: `Erro: ${error.message}` }] }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ data: data || [], total: count ?? 0 }) }] }
    }
  )

  // ── Tool 2: Criar ou atualizar meta mensal ──
  server.tool(
    'upsert_meta',
    'Cria ou atualiza a meta de vendas de um mês específico. Se já existir meta para o mês, atualiza o valor.',
    {
      mes: z.string().regex(/^\d{4}-\d{2}$/).describe('Mês no formato YYYY-MM (ex: 2026-02)'),
      valor_meta: z.number().positive().describe('Valor da meta de vendas'),
    },
    async ({ mes, valor_meta }) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()

      const { data, error } = await supabase
        .from('metas')
        .upsert(
          {
            organization_id: orgId,
            mes,
            valor_meta,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'organization_id,mes' }
        )
        .select()
        .single()

      if (error) return { content: [{ type: 'text' as const, text: `Erro: ${error.message}` }] }

      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
    }
  )

  // ── Tool 3: Excluir meta ──
  server.tool(
    'delete_meta',
    'Remove uma meta de vendas',
    {
      id: z.string().describe('ID da meta (UUID)'),
    },
    async ({ id }) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()

      const { data: existing } = await supabase
        .from('metas')
        .select('id')
        .eq('id', id)
        .eq('organization_id', orgId)
        .single()

      if (!existing) return { content: [{ type: 'text' as const, text: 'Meta não encontrada' }] }

      const { error } = await supabase.from('metas').delete().eq('id', id)

      if (error) return { content: [{ type: 'text' as const, text: `Erro: ${error.message}` }] }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, id }) }] }
    }
  )
}
