import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getSupabase } from '../supabase.js'

const TIPOS = ['compromisso', 'servico', 'reuniao', 'lembrete', 'outro'] as const
const STATUS = ['agendado', 'confirmado', 'em_andamento', 'concluido', 'cancelado'] as const

export function registerAgendamentosTools(server: McpServer, orgId: string | null) {
  // ── Tool 1: Listar agendamentos ──
  server.tool(
    'list_agendamentos',
    'Lista agendamentos com filtros por tipo, status e período',
    {
      tipo: z.enum(TIPOS).optional().describe('Filtrar por tipo'),
      status: z.enum(STATUS).optional().describe('Filtrar por status'),
      data_inicio: z.string().optional().describe('Data início (YYYY-MM-DD) para filtro'),
      data_fim: z.string().optional().describe('Data fim (YYYY-MM-DD) para filtro'),
      page: z.number().min(1).default(1),
      limit: z.number().min(1).max(100).default(20),
    },
    async ({ tipo, status, data_inicio, data_fim, page, limit }) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()
      let query = supabase
        .from('agendamentos')
        .select('*', { count: 'exact' })
        .eq('organization_id', orgId)

      if (tipo) query = query.eq('tipo', tipo)
      if (status) query = query.eq('status', status)
      if (data_inicio) query = query.gte('data_inicio', data_inicio)
      if (data_fim) query = query.lte('data_inicio', data_fim)

      const from = (page - 1) * limit
      const { data, count, error } = await query
        .order('data_inicio', { ascending: true })
        .range(from, from + limit - 1)

      if (error) return { content: [{ type: 'text' as const, text: `Erro: ${error.message}` }] }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ data: data || [], total: count ?? 0, page, limit }) }] }
    }
  )

  // ── Tool 2: Buscar agendamento por ID ──
  server.tool(
    'get_agendamento',
    'Busca um agendamento específico por ID',
    {
      id: z.string().describe('ID do agendamento (UUID)'),
    },
    async ({ id }) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()
      const { data, error } = await supabase
        .from('agendamentos')
        .select('*')
        .eq('id', id)
        .eq('organization_id', orgId)
        .single()

      if (error || !data) return { content: [{ type: 'text' as const, text: 'Agendamento não encontrado' }] }

      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
    }
  )

  // ── Tool 3: Criar agendamento ──
  server.tool(
    'create_agendamento',
    'Cria um novo agendamento (compromisso, serviço, reunião, lembrete)',
    {
      titulo: z.string().min(1).describe('Título do agendamento'),
      tipo: z.enum(TIPOS).describe('Tipo: compromisso, servico, reuniao, lembrete, outro'),
      data_inicio: z.string().describe('Data/hora de início (ISO 8601)'),
      data_fim: z.string().optional().nullable().describe('Data/hora de fim (ISO 8601)'),
      dia_inteiro: z.boolean().default(false).describe('Evento de dia inteiro?'),
      descricao: z.string().optional().nullable().describe('Descrição'),
      cliente_id: z.string().optional().nullable().describe('ID do cliente associado'),
      cliente_nome: z.string().optional().nullable().describe('Nome do cliente'),
      cor: z.string().default('#3B82F6').describe('Cor hex do agendamento'),
      local: z.string().optional().nullable().describe('Local do agendamento'),
      observacoes: z.string().optional().nullable().describe('Observações'),
      lembrete_minutos: z.number().optional().nullable().describe('Lembrete em minutos antes'),
    },
    async (input) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()
      const { data, error } = await supabase
        .from('agendamentos')
        .insert({
          organization_id: orgId,
          titulo: input.titulo.trim(),
          tipo: input.tipo,
          status: 'agendado',
          data_inicio: input.data_inicio,
          data_fim: input.data_fim || null,
          dia_inteiro: input.dia_inteiro,
          descricao: input.descricao || null,
          cliente_id: input.cliente_id || null,
          cliente_nome: input.cliente_nome || null,
          cor: input.cor,
          local: input.local || null,
          observacoes: input.observacoes || null,
          lembrete_minutos: input.lembrete_minutos ?? null,
        })
        .select()
        .single()

      if (error || !data) {
        return { content: [{ type: 'text' as const, text: `Erro ao criar: ${error?.message}` }] }
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
    }
  )

  // ── Tool 4: Atualizar agendamento ──
  server.tool(
    'update_agendamento',
    'Atualiza um agendamento existente. Envie apenas os campos que deseja alterar.',
    {
      id: z.string().describe('ID do agendamento'),
      titulo: z.string().optional().describe('Título'),
      tipo: z.enum(TIPOS).optional(),
      status: z.enum(STATUS).optional(),
      data_inicio: z.string().optional(),
      data_fim: z.string().optional().nullable(),
      dia_inteiro: z.boolean().optional(),
      descricao: z.string().optional().nullable(),
      cliente_id: z.string().optional().nullable(),
      cliente_nome: z.string().optional().nullable(),
      cor: z.string().optional(),
      local: z.string().optional().nullable(),
      observacoes: z.string().optional().nullable(),
      lembrete_minutos: z.number().optional().nullable(),
    },
    async (input) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()

      const { data: existing } = await supabase
        .from('agendamentos')
        .select('id')
        .eq('id', input.id)
        .eq('organization_id', orgId)
        .single()

      if (!existing) return { content: [{ type: 'text' as const, text: 'Agendamento não encontrado' }] }

      const payload: Record<string, any> = { updated_at: new Date().toISOString() }
      if (input.titulo !== undefined) payload.titulo = input.titulo.trim()
      if (input.tipo !== undefined) payload.tipo = input.tipo
      if (input.status !== undefined) payload.status = input.status
      if (input.data_inicio !== undefined) payload.data_inicio = input.data_inicio
      if (input.data_fim !== undefined) payload.data_fim = input.data_fim
      if (input.dia_inteiro !== undefined) payload.dia_inteiro = input.dia_inteiro
      if (input.descricao !== undefined) payload.descricao = input.descricao
      if (input.cliente_id !== undefined) payload.cliente_id = input.cliente_id
      if (input.cliente_nome !== undefined) payload.cliente_nome = input.cliente_nome
      if (input.cor !== undefined) payload.cor = input.cor
      if (input.local !== undefined) payload.local = input.local
      if (input.observacoes !== undefined) payload.observacoes = input.observacoes
      if (input.lembrete_minutos !== undefined) payload.lembrete_minutos = input.lembrete_minutos

      const { data, error } = await supabase
        .from('agendamentos')
        .update(payload)
        .eq('id', input.id)
        .eq('organization_id', orgId)
        .select()
        .single()

      if (error) return { content: [{ type: 'text' as const, text: `Erro: ${error.message}` }] }

      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
    }
  )

  // ── Tool 5: Excluir agendamento ──
  server.tool(
    'delete_agendamento',
    'Remove um agendamento',
    {
      id: z.string().describe('ID do agendamento'),
    },
    async ({ id }) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()

      const { data: existing } = await supabase
        .from('agendamentos')
        .select('id')
        .eq('id', id)
        .eq('organization_id', orgId)
        .single()

      if (!existing) return { content: [{ type: 'text' as const, text: 'Agendamento não encontrado' }] }

      const { error } = await supabase.from('agendamentos').delete().eq('id', id)

      if (error) return { content: [{ type: 'text' as const, text: `Erro: ${error.message}` }] }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, id }) }] }
    }
  )
}
