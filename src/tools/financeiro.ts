import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getSupabase } from '../supabase.js'

const TIPOS = ['receita', 'despesa'] as const
const STATUS = ['pendente', 'pago', 'vencido', 'cancelado'] as const
const FORMAS_PAGAMENTO = ['dinheiro', 'pix', 'cartao_credito', 'cartao_debito', 'boleto', 'transferencia'] as const

/** Verifica limite de uso antes de criar recurso */
async function enforceUsageLimit(orgId: string, resource: 'transactions' | 'quotes') {
  const supabase = getSupabase()
  const { data: usage } = await supabase
    .from('vw_organization_usage_summary')
    .select('*')
    .eq('organization_id', orgId)
    .single()

  if (!usage) return // fail-open

  const map: Record<string, { current: string; max: string }> = {
    transactions: { current: 'transactions_used', max: 'max_transactions_month' },
    quotes: { current: 'quotes_used', max: 'max_quotes_month' },
  }

  const m = map[resource]
  if (!m) return

  const current = (usage as any)[m.current] || 0
  const limit = (usage as any)[m.max]

  if (limit !== null && current >= limit) {
    throw new Error(`Limite de ${resource} atingido (${current}/${limit}). Faça upgrade do plano.`)
  }
}

/** Incrementa contador de uso mensal */
async function incrementUsage(orgId: string, resource: 'transactions' | 'quotes') {
  const supabase = getSupabase()
  const funcMap: Record<string, string> = {
    transactions: 'increment_transactions_count',
    quotes: 'increment_quotes_count',
  }
  const fn = funcMap[resource]
  if (fn) {
    await supabase.rpc(fn, { p_org_id: orgId })
  }
}

export function registerFinanceiroTools(server: McpServer, orgId: string | null) {
  // ── Tool 1: Listar lançamentos ──
  server.tool(
    'list_financeiro',
    'Lista lançamentos financeiros com filtros e paginação. Retorna receitas e/ou despesas.',
    {
      tipo: z.enum(TIPOS).optional().describe('Filtrar por tipo: receita ou despesa'),
      status: z.enum(STATUS).optional().describe('Filtrar por status: pendente, pago, vencido, cancelado'),
      categoria: z.string().optional().describe('Filtrar por categoria (busca parcial)'),
      data_inicio: z.string().optional().describe('Data início (YYYY-MM-DD) para filtro por data_vencimento'),
      data_fim: z.string().optional().describe('Data fim (YYYY-MM-DD) para filtro por data_vencimento'),
      page: z.number().min(1).default(1).describe('Página'),
      limit: z.number().min(1).max(100).default(20).describe('Itens por página'),
    },
    async ({ tipo, status, categoria, data_inicio, data_fim, page, limit }) => {
      if (!orgId) {
        return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }
      }

      const supabase = getSupabase()
      let query = supabase
        .from('financeiro')
        .select('*', { count: 'exact' })
        .eq('organization_id', orgId)

      if (tipo) query = query.eq('tipo', tipo)
      if (status) query = query.eq('status', status)
      if (categoria) query = query.ilike('categoria', `%${categoria}%`)
      if (data_inicio) query = query.gte('data_vencimento', data_inicio)
      if (data_fim) query = query.lte('data_vencimento', data_fim)

      const from = (page - 1) * limit
      const { data, count, error } = await query
        .order('data_vencimento', { ascending: false, nullsFirst: false })
        .range(from, from + limit - 1)

      if (error) {
        return { content: [{ type: 'text' as const, text: `Erro: ${error.message}` }] }
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ data: data || [], total: count ?? 0, page, limit }) }],
      }
    }
  )

  // ── Tool 2: Buscar lançamento por ID ──
  server.tool(
    'get_financeiro',
    'Busca um lançamento financeiro específico por ID',
    {
      id: z.string().describe('ID do lançamento (UUID)'),
    },
    async ({ id }) => {
      if (!orgId) {
        return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }
      }

      const supabase = getSupabase()
      const { data, error } = await supabase
        .from('financeiro')
        .select('*')
        .eq('id', id)
        .eq('organization_id', orgId)
        .single()

      if (error || !data) {
        return { content: [{ type: 'text' as const, text: 'Lançamento não encontrado' }] }
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
    }
  )

  // ── Tool 3: Criar lançamento ──
  server.tool(
    'create_financeiro',
    'Cria um novo lançamento financeiro (receita ou despesa)',
    {
      tipo: z.enum(TIPOS).describe('Tipo: receita ou despesa'),
      descricao: z.string().min(1).describe('Descrição do lançamento'),
      valor: z.number().positive().describe('Valor (deve ser > 0)'),
      status: z.enum(STATUS).default('pendente').describe('Status inicial'),
      valor_pago: z.number().optional().describe('Valor já pago'),
      data_vencimento: z.string().optional().describe('Data de vencimento (YYYY-MM-DD)'),
      data_pagamento: z.string().optional().describe('Data de pagamento (YYYY-MM-DD)'),
      forma_pagamento: z.enum(FORMAS_PAGAMENTO).optional().describe('Forma de pagamento'),
      categoria: z.string().optional().describe('Categoria do lançamento'),
      observacoes: z.string().optional().describe('Observações'),
      cliente_id: z.string().optional().describe('ID do cliente associado'),
      fornecedor_id: z.string().optional().describe('ID do fornecedor associado'),
      produto_id: z.string().optional().describe('ID do produto associado'),
    },
    async (input) => {
      if (!orgId) {
        return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }
      }

      try {
        await enforceUsageLimit(orgId, 'transactions')
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Limite: ${err.message}` }] }
      }

      const supabase = getSupabase()
      const { data, error } = await supabase
        .from('financeiro')
        .insert({
          organization_id: orgId,
          tipo: input.tipo,
          descricao: input.descricao.trim(),
          valor: input.valor,
          status: input.status,
          valor_pago: input.valor_pago ?? 0,
          data_vencimento: input.data_vencimento || null,
          data_pagamento: input.data_pagamento || null,
          forma_pagamento: input.forma_pagamento || null,
          categoria: input.categoria || null,
          observacoes: input.observacoes || null,
          cliente_id: input.cliente_id || null,
          fornecedor_id: input.fornecedor_id || null,
          produto_id: input.produto_id || null,
        })
        .select()
        .single()

      if (error || !data) {
        return { content: [{ type: 'text' as const, text: `Erro ao criar: ${error?.message}` }] }
      }

      // Incrementar contador de uso
      await incrementUsage(orgId, 'transactions')

      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
    }
  )

  // ── Tool 4: Atualizar lançamento ──
  server.tool(
    'update_financeiro',
    'Atualiza um lançamento financeiro existente. Envie apenas os campos que deseja alterar.',
    {
      id: z.string().describe('ID do lançamento (UUID)'),
      tipo: z.enum(TIPOS).optional().describe('Tipo: receita ou despesa'),
      descricao: z.string().optional().describe('Descrição'),
      valor: z.number().positive().optional().describe('Valor (> 0)'),
      status: z.enum(STATUS).optional().describe('Status'),
      valor_pago: z.number().optional().nullable().describe('Valor pago'),
      data_vencimento: z.string().optional().nullable().describe('Data de vencimento'),
      data_pagamento: z.string().optional().nullable().describe('Data de pagamento'),
      forma_pagamento: z.enum(FORMAS_PAGAMENTO).optional().nullable().describe('Forma de pagamento'),
      categoria: z.string().optional().nullable().describe('Categoria'),
      observacoes: z.string().optional().nullable().describe('Observações'),
      cliente_id: z.string().optional().nullable().describe('ID do cliente'),
      fornecedor_id: z.string().optional().nullable().describe('ID do fornecedor'),
      produto_id: z.string().optional().nullable().describe('ID do produto'),
    },
    async (input) => {
      if (!orgId) {
        return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }
      }

      const supabase = getSupabase()

      // Verificar que pertence à organização
      const { data: existing, error: fetchErr } = await supabase
        .from('financeiro')
        .select('id')
        .eq('id', input.id)
        .eq('organization_id', orgId)
        .single()

      if (fetchErr || !existing) {
        return { content: [{ type: 'text' as const, text: 'Lançamento não encontrado' }] }
      }

      // Montar payload parcial
      const payload: Record<string, any> = { updated_at: new Date().toISOString() }
      if (input.tipo !== undefined) payload.tipo = input.tipo
      if (input.descricao !== undefined) payload.descricao = input.descricao.trim()
      if (input.valor !== undefined) payload.valor = input.valor
      if (input.status !== undefined) payload.status = input.status
      if (input.valor_pago !== undefined) payload.valor_pago = input.valor_pago
      if (input.data_vencimento !== undefined) payload.data_vencimento = input.data_vencimento
      if (input.data_pagamento !== undefined) payload.data_pagamento = input.data_pagamento
      if (input.forma_pagamento !== undefined) payload.forma_pagamento = input.forma_pagamento
      if (input.categoria !== undefined) payload.categoria = input.categoria
      if (input.observacoes !== undefined) payload.observacoes = input.observacoes
      if (input.cliente_id !== undefined) payload.cliente_id = input.cliente_id
      if (input.fornecedor_id !== undefined) payload.fornecedor_id = input.fornecedor_id
      if (input.produto_id !== undefined) payload.produto_id = input.produto_id

      const { data, error } = await supabase
        .from('financeiro')
        .update(payload)
        .eq('id', input.id)
        .eq('organization_id', orgId)
        .select()
        .single()

      if (error || !data) {
        return { content: [{ type: 'text' as const, text: `Erro ao atualizar: ${error?.message}` }] }
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
    }
  )

  // ── Tool 5: Excluir lançamento ──
  server.tool(
    'delete_financeiro',
    'Remove um lançamento financeiro',
    {
      id: z.string().describe('ID do lançamento (UUID)'),
    },
    async ({ id }) => {
      if (!orgId) {
        return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }
      }

      const supabase = getSupabase()

      // Verificar que pertence à organização
      const { data: existing, error: fetchErr } = await supabase
        .from('financeiro')
        .select('id')
        .eq('id', id)
        .eq('organization_id', orgId)
        .single()

      if (fetchErr || !existing) {
        return { content: [{ type: 'text' as const, text: 'Lançamento não encontrado' }] }
      }

      const { error } = await supabase
        .from('financeiro')
        .delete()
        .eq('id', id)

      if (error) {
        return { content: [{ type: 'text' as const, text: `Erro ao excluir: ${error.message}` }] }
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, id }) }] }
    }
  )
}
