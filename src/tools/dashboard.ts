import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getSupabase } from '../supabase.js'

export function registerDashboardTools(server: McpServer, orgId: string | null) {
  // ── Tool 1: Resumo Geral do Dashboard ──
  server.tool(
    'get_dashboard_resumo',
    'Retorna resumo geral do negócio: financeiro, faturas pendentes, clientes ativos, orçamentos e lançamentos recentes',
    {
      limit_recentes: z.number().min(1).max(50).default(10).describe('Quantidade de lançamentos recentes'),
    },
    async ({ limit_recentes }) => {
      const supabase = getSupabase()

      if (!orgId) {
        return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório para dashboard' }] }
      }

      const [resumoFin, faturas, clientes, orcamentos, recentes] = await Promise.all([
        supabase
          .from('vw_dashboard_resumo_financeiro')
          .select('*')
          .eq('organization_id', orgId)
          .maybeSingle(),
        supabase
          .from('vw_dashboard_faturas_pendentes')
          .select('*')
          .eq('organization_id', orgId)
          .maybeSingle(),
        supabase
          .from('vw_dashboard_clientes_ativos')
          .select('*')
          .eq('organization_id', orgId)
          .maybeSingle(),
        supabase
          .from('vw_dashboard_orcamentos_resumo')
          .select('*')
          .eq('organization_id', orgId)
          .maybeSingle(),
        supabase
          .from('vw_dashboard_lancamentos_recentes')
          .select('*')
          .eq('organization_id', orgId)
          .limit(limit_recentes),
      ])

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            resumo_financeiro: resumoFin.data || null,
            faturas_pendentes: faturas.data || null,
            clientes_ativos: clientes.data || null,
            orcamentos_resumo: orcamentos.data || null,
            lancamentos_recentes: recentes.data || [],
          }),
        }],
      }
    }
  )

  // ── Tool 2: KPIs do Mês ──
  server.tool(
    'get_dashboard_kpis',
    'Retorna KPIs do mês atual: receita/despesa planejada, realizada e pendente, com comparação ao mês anterior',
    {},
    async () => {
      const supabase = getSupabase()

      if (!orgId) {
        return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }
      }

      const { data, error } = await supabase
        .from('vw_dashboard_kpi_resumo')
        .select('*')
        .eq('organization_id', orgId)
        .maybeSingle()

      if (error) {
        return { content: [{ type: 'text' as const, text: `Erro: ${error.message}` }] }
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(data || { message: 'Sem dados de KPIs para esta organização' }) }] }
    }
  )

  // ── Tool 3: Gastos por Categoria ──
  server.tool(
    'get_dashboard_gastos_categoria',
    'Retorna gastos (despesas) agrupados por categoria no mês atual, com comparação ao mês anterior',
    {},
    async () => {
      const supabase = getSupabase()

      if (!orgId) {
        return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }
      }

      const { data, error } = await supabase
        .from('vw_dashboard_gastos_categoria')
        .select('*')
        .eq('organization_id', orgId)

      if (error) {
        return { content: [{ type: 'text' as const, text: `Erro: ${error.message}` }] }
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(data || []) }] }
    }
  )

  // ── Tool 4: Fluxo de Caixa Mensal ──
  server.tool(
    'get_fluxo_mensal',
    'Retorna fluxo de caixa mensal (entradas, saídas, saldo) dos últimos N meses',
    {
      limit: z.number().min(1).max(24).default(6).describe('Quantidade de meses'),
    },
    async ({ limit }) => {
      const supabase = getSupabase()

      if (!orgId) {
        return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }
      }

      const { data, error } = await supabase
        .from('vw_financeiro_fluxo_mensal')
        .select('*')
        .eq('organization_id', orgId)
        .order('mes', { ascending: false })
        .limit(limit)

      if (error) {
        return { content: [{ type: 'text' as const, text: `Erro: ${error.message}` }] }
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(data || []) }] }
    }
  )

  // ── Tool 5: Ações Pendentes ──
  server.tool(
    'get_acoes_pendentes',
    'Retorna ações pendentes que precisam de atenção: faturas vencidas, orçamentos expirando, estoque baixo, etc.',
    {},
    async () => {
      const supabase = getSupabase()

      if (!orgId) {
        return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }
      }

      // Queries diretas em vez de RPC (evita dependência de função no banco)
      const today = new Date().toISOString().split('T')[0]

      const [vencidas, venceHoje, orcExpirando] = await Promise.all([
        // 1. Faturas vencidas
        supabase
          .from('financeiro')
          .select('descricao, valor, data_vencimento')
          .eq('organization_id', orgId)
          .in('status', ['pendente', 'vencido'])
          .lt('data_vencimento', today)
          .order('data_vencimento', { ascending: true })
          .limit(5),
        // 2. Vencem hoje
        supabase
          .from('financeiro')
          .select('descricao, valor, data_vencimento')
          .eq('organization_id', orgId)
          .eq('status', 'pendente')
          .eq('data_vencimento', today)
          .order('valor', { ascending: false })
          .limit(5),
        // 3. Orçamentos expirando em 7 dias
        supabase
          .from('orcamentos')
          .select('numero, cliente_nome, valor_total, validade')
          .eq('organization_id', orgId)
          .eq('status', 'enviado')
          .not('validade', 'is', null)
          .gte('validade', today)
          .lte('validade', new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0])
          .order('validade', { ascending: true })
          .limit(5),
      ])

      const acoes: any[] = []

      for (const f of vencidas.data || []) {
        acoes.push({ tipo: 'fatura_vencida', titulo: f.descricao, descricao: `Venceu em ${f.data_vencimento}`, valor: f.valor, prioridade: 1, icon: 'error' })
      }
      for (const f of venceHoje.data || []) {
        acoes.push({ tipo: 'vence_hoje', titulo: f.descricao, descricao: 'Vence hoje', valor: f.valor, prioridade: 2, icon: 'schedule' })
      }
      for (const o of orcExpirando.data || []) {
        acoes.push({ tipo: 'orcamento_expirando', titulo: `Orçamento #${o.numero} - ${o.cliente_nome}`, descricao: `Validade em ${o.validade}`, valor: o.valor_total, prioridade: 3, icon: 'timer' })
      }

      acoes.sort((a, b) => a.prioridade - b.prioridade)

      return { content: [{ type: 'text' as const, text: JSON.stringify(acoes.slice(0, 5)) }] }
    }
  )
}
