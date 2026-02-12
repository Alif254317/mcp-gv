import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getSupabase } from '../supabase.js'

const STATUS = ['criado', 'enviado', 'aprovado', 'recusado'] as const

const ItemSchema = z.object({
  descricao: z.string().min(1).describe('Descrição do item'),
  valor_unitario: z.number().min(0).describe('Valor unitário'),
  quantidade: z.number().min(1).default(1).describe('Quantidade'),
  desconto: z.number().min(0).default(0).describe('Desconto do item'),
  produto_id: z.string().optional().nullable().describe('ID do produto'),
})

/** Verifica limite de uso */
async function enforceQuotesLimit(orgId: string) {
  const supabase = getSupabase()
  const { data: usage } = await supabase
    .from('vw_organization_usage_summary')
    .select('quotes_used, max_quotes_month')
    .eq('organization_id', orgId)
    .single()

  if (!usage) return
  const current = (usage as any).quotes_used || 0
  const limit = (usage as any).max_quotes_month

  if (limit !== null && current >= limit) {
    throw new Error(`Limite de orçamentos atingido (${current}/${limit}). Faça upgrade do plano.`)
  }
}

async function incrementQuotes(orgId: string) {
  const supabase = getSupabase()
  await supabase.rpc('increment_quotes_count', { p_org_id: orgId })
}

export function registerOrcamentosTools(server: McpServer, orgId: string | null) {
  // ── Tool 1: Listar orçamentos ──
  server.tool(
    'list_orcamentos',
    'Lista orçamentos com filtros e paginação',
    {
      status: z.enum(STATUS).optional().describe('Filtrar por status'),
      cliente: z.string().optional().describe('Filtrar por nome do cliente (busca parcial)'),
      page: z.number().min(1).default(1),
      limit: z.number().min(1).max(100).default(20),
    },
    async ({ status, cliente, page, limit }) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()
      let query = supabase
        .from('orcamentos')
        .select('id, numero, cliente_nome, cliente_telefone, cliente_email, cliente_id, status, descricao, valor_desconto, valor_total, validade, created_at, updated_at', { count: 'exact' })
        .eq('organization_id', orgId)

      if (status) query = query.eq('status', status)
      if (cliente) query = query.ilike('cliente_nome', `%${cliente}%`)

      const from = (page - 1) * limit
      const { data, count, error } = await query
        .order('created_at', { ascending: false })
        .range(from, from + limit - 1)

      if (error) return { content: [{ type: 'text' as const, text: `Erro: ${error.message}` }] }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ data: data || [], total: count ?? 0, page, limit }) }] }
    }
  )

  // ── Tool 2: Buscar orçamento com itens ──
  server.tool(
    'get_orcamento',
    'Busca um orçamento específico por ID, incluindo seus itens',
    {
      id: z.string().describe('ID do orçamento (UUID)'),
    },
    async ({ id }) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()

      const [orcResult, itensResult] = await Promise.all([
        supabase
          .from('orcamentos')
          .select('*')
          .eq('id', id)
          .eq('organization_id', orgId)
          .single(),
        supabase
          .from('orcamento_itens')
          .select('*')
          .eq('orcamento_id', id)
          .order('ordem', { ascending: true }),
      ])

      if (orcResult.error || !orcResult.data) {
        return { content: [{ type: 'text' as const, text: 'Orçamento não encontrado' }] }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ...orcResult.data, itens: itensResult.data || [] }),
        }],
      }
    }
  )

  // ── Tool 3: Criar orçamento com itens ──
  server.tool(
    'create_orcamento',
    'Cria um novo orçamento com itens. Calcula subtotais e valor total automaticamente.',
    {
      cliente_nome: z.string().min(1).describe('Nome do cliente'),
      itens: z.array(ItemSchema).min(1).describe('Lista de itens do orçamento'),
      cliente_id: z.string().optional().nullable().describe('ID do cliente cadastrado'),
      cliente_telefone: z.string().optional().nullable().describe('Telefone do cliente'),
      cliente_email: z.string().optional().nullable().describe('Email do cliente'),
      descricao: z.string().optional().nullable().describe('Descrição/observações do orçamento'),
      validade: z.string().optional().nullable().describe('Data de validade (YYYY-MM-DD)'),
      valor_desconto: z.number().min(0).default(0).describe('Desconto global no orçamento'),
    },
    async (input) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      try {
        await enforceQuotesLimit(orgId)
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Limite: ${err.message}` }] }
      }

      // Calcular subtotais
      const itensCalculados = input.itens.map((item, i) => {
        const subtotal = Math.max(item.quantidade * item.valor_unitario - item.desconto, 0)
        return {
          descricao: item.descricao,
          quantidade: item.quantidade,
          valor_unitario: item.valor_unitario,
          desconto: item.desconto,
          subtotal,
          produto_id: item.produto_id || null,
          ordem: i,
        }
      })

      const somaItens = itensCalculados.reduce((sum, it) => sum + it.subtotal, 0)
      const valorTotal = Math.max(somaItens - input.valor_desconto, 0)

      const supabase = getSupabase()

      // Inserir orçamento
      const { data: orcamento, error: orcErr } = await supabase
        .from('orcamentos')
        .insert({
          organization_id: orgId,
          cliente_id: input.cliente_id || null,
          cliente_nome: input.cliente_nome.trim(),
          cliente_telefone: input.cliente_telefone || null,
          cliente_email: input.cliente_email || null,
          status: 'criado',
          descricao: input.descricao || null,
          valor_desconto: input.valor_desconto,
          valor_total: valorTotal,
          validade: input.validade || null,
        })
        .select()
        .single()

      if (orcErr || !orcamento) {
        return { content: [{ type: 'text' as const, text: `Erro ao criar orçamento: ${orcErr?.message}` }] }
      }

      // Inserir itens
      const itensParaInserir = itensCalculados.map((item) => ({
        orcamento_id: (orcamento as any).id,
        produto_id: item.produto_id,
        descricao: item.descricao,
        quantidade: item.quantidade,
        valor_unitario: item.valor_unitario,
        desconto: item.desconto,
        ordem: item.ordem,
      }))

      const { error: itensErr } = await supabase
        .from('orcamento_itens')
        .insert(itensParaInserir)

      if (itensErr) {
        // Rollback
        await supabase.from('orcamentos').delete().eq('id', (orcamento as any).id)
        return { content: [{ type: 'text' as const, text: `Erro ao criar itens: ${itensErr.message}` }] }
      }

      await incrementQuotes(orgId)

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ...orcamento, itens: itensCalculados }),
        }],
      }
    }
  )

  // ── Tool 4: Atualizar orçamento ──
  server.tool(
    'update_orcamento',
    'Atualiza um orçamento existente (status, dados do cliente, desconto). Para atualizar itens, use delete + create.',
    {
      id: z.string().describe('ID do orçamento'),
      status: z.enum(STATUS).optional().describe('Novo status'),
      cliente_nome: z.string().optional().describe('Nome do cliente'),
      cliente_telefone: z.string().optional().nullable(),
      cliente_email: z.string().optional().nullable(),
      descricao: z.string().optional().nullable(),
      valor_desconto: z.number().min(0).optional(),
      validade: z.string().optional().nullable(),
    },
    async (input) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()

      const { data: existing } = await supabase
        .from('orcamentos')
        .select('id')
        .eq('id', input.id)
        .eq('organization_id', orgId)
        .single()

      if (!existing) return { content: [{ type: 'text' as const, text: 'Orçamento não encontrado' }] }

      const payload: Record<string, any> = { updated_at: new Date().toISOString() }
      if (input.status !== undefined) payload.status = input.status
      if (input.cliente_nome !== undefined) payload.cliente_nome = input.cliente_nome.trim()
      if (input.cliente_telefone !== undefined) payload.cliente_telefone = input.cliente_telefone
      if (input.cliente_email !== undefined) payload.cliente_email = input.cliente_email
      if (input.descricao !== undefined) payload.descricao = input.descricao
      if (input.valor_desconto !== undefined) payload.valor_desconto = input.valor_desconto
      if (input.validade !== undefined) payload.validade = input.validade

      const { data, error } = await supabase
        .from('orcamentos')
        .update(payload)
        .eq('id', input.id)
        .eq('organization_id', orgId)
        .select()
        .single()

      if (error) return { content: [{ type: 'text' as const, text: `Erro: ${error.message}` }] }

      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
    }
  )

  // ── Tool 5: Excluir orçamento ──
  server.tool(
    'delete_orcamento',
    'Remove um orçamento e seus itens',
    {
      id: z.string().describe('ID do orçamento'),
    },
    async ({ id }) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()

      const { data: existing } = await supabase
        .from('orcamentos')
        .select('id')
        .eq('id', id)
        .eq('organization_id', orgId)
        .single()

      if (!existing) return { content: [{ type: 'text' as const, text: 'Orçamento não encontrado' }] }

      // Deletar itens primeiro, depois orçamento
      await supabase.from('orcamento_itens').delete().eq('orcamento_id', id)
      const { error } = await supabase.from('orcamentos').delete().eq('id', id)

      if (error) return { content: [{ type: 'text' as const, text: `Erro: ${error.message}` }] }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, id }) }] }
    }
  )
}
