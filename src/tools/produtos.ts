import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getSupabase } from '../supabase.js'

export function registerProdutosTools(server: McpServer, orgId: string | null) {
  // ── Tool 1: Listar produtos ──
  server.tool(
    'list_produtos',
    'Lista produtos/servicos cadastrados com busca por nome, tipo e status',
    {
      busca: z.string().optional().describe('Busca por nome ou descricao (parcial)'),
      tipo: z.enum(['produto', 'servico']).optional().describe('Filtrar por tipo: produto ou servico'),
      ativo: z.boolean().optional().describe('Filtrar por ativo/inativo'),
      page: z.number().min(1).default(1),
      limit: z.number().min(1).max(100).default(20),
    },
    async ({ busca, tipo, ativo, page, limit }) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()
      let query = supabase
        .from('produtos')
        .select('*', { count: 'exact' })
        .eq('organization_id', orgId)

      if (busca) {
        query = query.or(`nome.ilike.%${busca}%,descricao.ilike.%${busca}%`)
      }
      if (tipo) query = query.eq('tipo', tipo)
      if (ativo !== undefined) query = query.eq('ativo', ativo)

      const from = (page - 1) * limit
      const { data, count, error } = await query
        .order('nome', { ascending: true })
        .range(from, from + limit - 1)

      if (error) return { content: [{ type: 'text' as const, text: `Erro: ${error.message}` }] }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ data: data || [], total: count ?? 0, page, limit }) }] }
    }
  )

  // ── Tool 2: Buscar produto por ID ──
  server.tool(
    'get_produto',
    'Busca um produto/servico pelo ID',
    {
      id: z.string().describe('ID (UUID) do produto'),
    },
    async ({ id }) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()
      const { data, error } = await supabase
        .from('produtos')
        .select('*')
        .eq('id', id)
        .eq('organization_id', orgId)
        .maybeSingle()

      if (error) return { content: [{ type: 'text' as const, text: `Erro: ${error.message}` }] }
      if (!data) return { content: [{ type: 'text' as const, text: JSON.stringify({ found: false }) }] }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ found: true, produto: data }) }] }
    }
  )

  // ── Tool 3: Criar produto ──
  server.tool(
    'create_produto',
    'Cria um novo produto ou servico',
    {
      nome: z.string().describe('Nome do produto/servico (obrigatório)'),
      tipo: z.enum(['produto', 'servico']).default('produto').describe('Tipo: produto ou servico'),
      descricao: z.string().optional().describe('Descricao'),
      unidade: z.string().optional().describe('Unidade de medida (un, kg, m, hr, etc)'),
      preco: z.number().describe('Preco de venda (obrigatório)'),
      custo: z.number().optional().describe('Custo do produto'),
      controla_estoque: z.boolean().default(false).describe('Se controla estoque'),
      estoque_atual: z.number().optional().describe('Quantidade em estoque'),
      estoque_minimo: z.number().optional().describe('Estoque minimo para alerta'),
      observacoes: z.string().optional().describe('Observacoes'),
    },
    async (params) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()
      const { data, error } = await supabase
        .from('produtos')
        .insert({
          organization_id: orgId,
          nome: params.nome.trim(),
          tipo: params.tipo,
          descricao: params.descricao || null,
          unidade: params.unidade || null,
          preco: params.preco,
          custo: params.custo ?? null,
          controla_estoque: params.controla_estoque,
          estoque_atual: params.estoque_atual ?? null,
          estoque_minimo: params.estoque_minimo ?? null,
          observacoes: params.observacoes || null,
        })
        .select()
        .single()

      if (error) return { content: [{ type: 'text' as const, text: `Erro: ${error.message}` }] }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, produto: data }) }] }
    }
  )

  // ── Tool 4: Atualizar produto ──
  server.tool(
    'update_produto',
    'Atualiza um produto/servico existente',
    {
      id: z.string().describe('ID (UUID) do produto'),
      nome: z.string().optional().describe('Nome'),
      tipo: z.enum(['produto', 'servico']).optional().describe('Tipo'),
      descricao: z.string().optional().describe('Descricao'),
      unidade: z.string().optional().describe('Unidade de medida'),
      preco: z.number().optional().describe('Preco de venda'),
      custo: z.number().optional().describe('Custo'),
      ativo: z.boolean().optional().describe('Ativo/inativo'),
      controla_estoque: z.boolean().optional().describe('Se controla estoque'),
      estoque_atual: z.number().optional().describe('Quantidade em estoque'),
      estoque_minimo: z.number().optional().describe('Estoque minimo'),
      observacoes: z.string().optional().describe('Observacoes'),
    },
    async ({ id, ...fields }) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) updates[key] = value
      }

      const supabase = getSupabase()
      const { data, error } = await supabase
        .from('produtos')
        .update(updates)
        .eq('id', id)
        .eq('organization_id', orgId)
        .select()
        .single()

      if (error) return { content: [{ type: 'text' as const, text: `Erro: ${error.message}` }] }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, produto: data }) }] }
    }
  )

  // ── Tool 5: Deletar produto ──
  server.tool(
    'delete_produto',
    'Remove um produto/servico pelo ID',
    {
      id: z.string().describe('ID (UUID) do produto'),
    },
    async ({ id }) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()
      const { error } = await supabase
        .from('produtos')
        .delete()
        .eq('id', id)
        .eq('organization_id', orgId)

      if (error) return { content: [{ type: 'text' as const, text: `Erro: ${error.message}` }] }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, deleted_id: id }) }] }
    }
  )
}
