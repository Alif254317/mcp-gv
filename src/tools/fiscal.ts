import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getSupabase } from '../supabase.js'

// ============================================
// FOCUS NFe — Helpers portados de server/utils/focusnfe.ts
// ============================================

const ICMS_ORIGEM_MAP: Record<string, string> = {
  nacional: '0',
  estrangeira_importacao: '1',
  estrangeira_mercado_interno: '2',
  nacional_importado_40_70: '3',
  nacional_processos: '4',
  nacional_importado_70: '5',
  estrangeira_sem_similar: '6',
  estrangeira_adquirida_mercado: '7',
  nacional_importado_70_substituido: '8',
}

const PRESENCA_MAP: Record<string, number> = {
  nao_se_aplica: 0,
  presencial: 1,
  internet: 2,
  televendas: 3,
  entrega_domicilio: 4,
  presencial_fora: 5,
  outros: 9,
}

const FINALIDADE_MAP: Record<string, number> = {
  normal: 1,
  complementar: 2,
  ajuste: 3,
  devolucao: 4,
}

const DEFAULT_CSOSN = '102'
const PIS_COFINS_CST_SIMPLES = '99'

function generateFocusRef(orgId: string, tipo: 'nfe' | 'nfse'): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 8)
  return `${tipo}_${orgId.substring(0, 8)}_${timestamp}_${random}`
}

function isMesmoEstado(ufEmitente: string, ufDestinatario: string): boolean {
  return ufEmitente.toUpperCase() === ufDestinatario.toUpperCase()
}

function getCfopVenda(dentroEstado: boolean, st: boolean = false): string {
  if (dentroEstado) return st ? '5405' : '5102'
  return st ? '6405' : '6102'
}

/**
 * Resolve o token Focus NFe correto a partir do fiscal_config.
 * Prioridade: token do ambiente configurado > focus_nfe_token legado > FOCUS_NFE_MASTER_TOKEN env
 */
function resolveFocusToken(cfg: any): string {
  const ambiente = cfg.focus_nfe_ambiente || 'homologacao'
  const token =
    (ambiente === 'producao' ? cfg.focus_nfe_token_producao : cfg.focus_nfe_token_homologacao) ||
    cfg.focus_nfe_token ||
    process.env.FOCUS_NFE_MASTER_TOKEN

  if (!token) {
    throw new Error(`Token Focus NFe não configurado para ambiente "${ambiente}". Configure pelo app web.`)
  }
  return token
}

/**
 * Resolve a URL base da API Focus NFe a partir do fiscal_config.
 */
function resolveFocusApiUrl(cfg: any): string {
  const ambiente = cfg.focus_nfe_ambiente || 'homologacao'
  if (ambiente === 'producao') {
    return process.env.FOCUS_NFE_API_URL || 'https://api.focusnfe.com.br'
  }
  return 'https://homologacao.focusnfe.com.br'
}

/** Fetch genérico para Focus NFe API */
async function focusFetch<T>(
  endpoint: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
    body?: any
    token: string
    apiUrl: string
  }
): Promise<T> {
  const url = `${options.apiUrl}${endpoint}`

  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${options.token}:`).toString('base64')}`,
    'Content-Type': 'application/json',
  }

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

  if (!response.ok) {
    const errorData = await response.json().catch(() => null)
    const mensagem =
      errorData?.mensagem ||
      errorData?.message ||
      errorData?.erro ||
      (errorData?.erros?.length && errorData.erros.map((e: any) => e.mensagem).join('; ')) ||
      `HTTP ${response.status}`
    throw new Error(mensagem)
  }

  return response.json() as Promise<T>
}

// ============================================
// TOOLS
// ============================================

export function registerFiscalTools(server: McpServer, orgId: string | null) {
  // ── Tool 1: Listar notas fiscais ──
  server.tool(
    'list_notas_fiscais',
    'Lista notas fiscais (NFe e NFSe) com filtros',
    {
      tipo: z.enum(['nfe', 'nfse']).optional().describe('Filtrar por tipo: nfe ou nfse'),
      status: z.string().optional().describe('Filtrar por status: rascunho, processando, autorizada, rejeitada, cancelada, erro'),
      cliente_id: z.string().optional().describe('Filtrar por cliente'),
      limit: z.number().min(1).max(100).default(20),
      offset: z.number().min(0).default(0),
    },
    async ({ tipo, status, cliente_id, limit, offset }) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()
      let query = supabase
        .from('notas_fiscais')
        .select('*', { count: 'exact' })
        .eq('organization_id', orgId)

      if (tipo) query = query.eq('tipo', tipo)
      if (status) query = query.eq('status', status)
      if (cliente_id) query = query.eq('cliente_id', cliente_id)

      const { data, count, error } = await query
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1)

      if (error) return { content: [{ type: 'text' as const, text: `Erro: ${error.message}` }] }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ notas: data || [], total: count ?? 0, limit, offset }) }] }
    }
  )

  // ── Tool 2: Buscar nota fiscal com itens ──
  server.tool(
    'get_nota_fiscal',
    'Busca uma nota fiscal específica por ID, incluindo seus itens',
    {
      id: z.string().describe('ID da nota fiscal (UUID)'),
    },
    async ({ id }) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()

      const [notaResult, itensResult] = await Promise.all([
        supabase
          .from('notas_fiscais')
          .select('*')
          .eq('id', id)
          .eq('organization_id', orgId)
          .single(),
        supabase
          .from('notas_fiscais_itens')
          .select('*')
          .eq('nota_fiscal_id', id)
          .order('numero_item', { ascending: true }),
      ])

      if (notaResult.error || !notaResult.data) {
        return { content: [{ type: 'text' as const, text: 'Nota fiscal não encontrada' }] }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ...notaResult.data, itens: itensResult.data || [] }),
        }],
      }
    }
  )

  // ── Tool 3: Criar nota fiscal (rascunho) ──
  server.tool(
    'create_nota_fiscal',
    'Cria uma nota fiscal em rascunho (NFe ou NFSe). O destinatário e os itens podem ser adicionados depois.',
    {
      tipo: z.enum(['nfe', 'nfse']).describe('Tipo: nfe (produtos) ou nfse (servicos)'),
      destinatario_nome: z.string().describe('Nome/Razao social do destinatario'),
      destinatario_cpf_cnpj: z.string().describe('CPF ou CNPJ do destinatario'),
      destinatario_tipo: z.enum(['pessoa_fisica', 'pessoa_juridica', 'estrangeiro']).optional().default('pessoa_juridica'),
      destinatario_email: z.string().optional().describe('Email do destinatario'),
      destinatario_telefone: z.string().optional().describe('Telefone do destinatario'),
      destinatario_cep: z.string().optional(),
      destinatario_logradouro: z.string().optional(),
      destinatario_numero: z.string().optional(),
      destinatario_complemento: z.string().optional(),
      destinatario_bairro: z.string().optional(),
      destinatario_municipio: z.string().optional(),
      destinatario_uf: z.string().optional(),
      destinatario_codigo_municipio: z.string().optional(),
      destinatario_ie: z.string().optional().describe('Inscricao Estadual do destinatario'),
      cliente_id: z.string().optional().describe('ID do cliente vinculado'),
      natureza_operacao: z.string().optional().default('Venda de mercadoria'),
      informacoes_adicionais: z.string().optional(),
      codigo_servico: z.string().optional().describe('Codigo do servico (NFSe)'),
      discriminacao_servicos: z.string().optional().describe('Descricao dos servicos (NFSe)'),
    },
    async (params) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()

      // Verificar config fiscal
      const { data: config } = await supabase
        .from('fiscal_config')
        .select('id, nfe_habilitado, nfse_habilitado')
        .eq('organization_id', orgId)
        .single()

      if (!config) {
        return { content: [{ type: 'text' as const, text: 'Configuração fiscal não encontrada. Configure pelo app web.' }] }
      }

      if (params.tipo === 'nfe' && !config.nfe_habilitado) {
        return { content: [{ type: 'text' as const, text: 'NFe não está habilitada nas configurações' }] }
      }
      if (params.tipo === 'nfse' && !config.nfse_habilitado) {
        return { content: [{ type: 'text' as const, text: 'NFSe não está habilitada nas configurações' }] }
      }

      const now = new Date().toISOString()

      const notaData: Record<string, any> = {
        organization_id: orgId,
        tipo: params.tipo,
        status: 'rascunho',
        cliente_id: params.cliente_id || null,
        destinatario_tipo: params.destinatario_tipo || 'pessoa_juridica',
        destinatario_nome: params.destinatario_nome,
        destinatario_cpf_cnpj: params.destinatario_cpf_cnpj.replace(/\D/g, ''),
        destinatario_ie: params.destinatario_ie || null,
        destinatario_email: params.destinatario_email || null,
        destinatario_telefone: params.destinatario_telefone || null,
        destinatario_cep: params.destinatario_cep || null,
        destinatario_logradouro: params.destinatario_logradouro || null,
        destinatario_numero: params.destinatario_numero || null,
        destinatario_complemento: params.destinatario_complemento || null,
        destinatario_bairro: params.destinatario_bairro || null,
        destinatario_municipio: params.destinatario_municipio || null,
        destinatario_uf: params.destinatario_uf || null,
        destinatario_codigo_municipio: params.destinatario_codigo_municipio || null,
        natureza_operacao: params.natureza_operacao || (params.tipo === 'nfe' ? 'Venda de mercadoria' : 'Prestacao de servico'),
        finalidade: 'normal',
        indicador_presenca: 'nao_se_aplica',
        codigo_servico: params.codigo_servico || null,
        discriminacao_servicos: params.discriminacao_servicos || null,
        iss_retido: false,
        informacoes_adicionais: params.informacoes_adicionais || null,
        valor_produtos: 0,
        valor_servicos: 0,
        valor_desconto: 0,
        valor_frete: 0,
        valor_seguro: 0,
        valor_outras_despesas: 0,
        valor_total: 0,
        valor_icms: 0,
        valor_icms_st: 0,
        valor_ipi: 0,
        valor_pis: 0,
        valor_cofins: 0,
        valor_iss: 0,
        valor_ir: 0,
        valor_csll: 0,
        valor_inss: 0,
        created_at: now,
        updated_at: now,
      }

      const { data: nota, error } = await supabase
        .from('notas_fiscais')
        .insert(notaData)
        .select()
        .single()

      if (error) {
        return { content: [{ type: 'text' as const, text: `Erro ao criar nota: ${error.message}` }] }
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, nota }) }] }
    }
  )

  // ── Tool 4: Atualizar nota fiscal (rascunho) ──
  server.tool(
    'update_nota_fiscal',
    'Atualiza uma nota fiscal em rascunho. Permite alterar destinatário e campos gerais.',
    {
      id: z.string().describe('ID da nota fiscal'),
      destinatario_nome: z.string().optional(),
      destinatario_cpf_cnpj: z.string().optional(),
      destinatario_tipo: z.enum(['pessoa_fisica', 'pessoa_juridica', 'estrangeiro']).optional(),
      destinatario_email: z.string().optional(),
      destinatario_telefone: z.string().optional(),
      destinatario_cep: z.string().optional(),
      destinatario_logradouro: z.string().optional(),
      destinatario_numero: z.string().optional(),
      destinatario_complemento: z.string().optional(),
      destinatario_bairro: z.string().optional(),
      destinatario_municipio: z.string().optional(),
      destinatario_uf: z.string().optional(),
      destinatario_codigo_municipio: z.string().optional(),
      destinatario_ie: z.string().optional(),
      natureza_operacao: z.string().optional(),
      informacoes_adicionais: z.string().optional(),
      codigo_servico: z.string().optional(),
      discriminacao_servicos: z.string().optional(),
      valor_desconto: z.number().optional(),
    },
    async (params) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()

      // Verificar nota existe e é rascunho
      const { data: existing } = await supabase
        .from('notas_fiscais')
        .select('id, status')
        .eq('id', params.id)
        .eq('organization_id', orgId)
        .single()

      if (!existing) return { content: [{ type: 'text' as const, text: 'Nota fiscal não encontrada' }] }
      if ((existing as any).status !== 'rascunho') {
        return { content: [{ type: 'text' as const, text: 'Apenas rascunhos podem ser editados' }] }
      }

      const updateData: Record<string, any> = { updated_at: new Date().toISOString() }

      if (params.destinatario_nome !== undefined) updateData.destinatario_nome = params.destinatario_nome
      if (params.destinatario_cpf_cnpj !== undefined) updateData.destinatario_cpf_cnpj = params.destinatario_cpf_cnpj.replace(/\D/g, '')
      if (params.destinatario_tipo !== undefined) updateData.destinatario_tipo = params.destinatario_tipo
      if (params.destinatario_email !== undefined) updateData.destinatario_email = params.destinatario_email
      if (params.destinatario_telefone !== undefined) updateData.destinatario_telefone = params.destinatario_telefone
      if (params.destinatario_cep !== undefined) updateData.destinatario_cep = params.destinatario_cep
      if (params.destinatario_logradouro !== undefined) updateData.destinatario_logradouro = params.destinatario_logradouro
      if (params.destinatario_numero !== undefined) updateData.destinatario_numero = params.destinatario_numero
      if (params.destinatario_complemento !== undefined) updateData.destinatario_complemento = params.destinatario_complemento
      if (params.destinatario_bairro !== undefined) updateData.destinatario_bairro = params.destinatario_bairro
      if (params.destinatario_municipio !== undefined) updateData.destinatario_municipio = params.destinatario_municipio
      if (params.destinatario_uf !== undefined) updateData.destinatario_uf = params.destinatario_uf
      if (params.destinatario_codigo_municipio !== undefined) updateData.destinatario_codigo_municipio = params.destinatario_codigo_municipio
      if (params.destinatario_ie !== undefined) updateData.destinatario_ie = params.destinatario_ie
      if (params.natureza_operacao !== undefined) updateData.natureza_operacao = params.natureza_operacao
      if (params.informacoes_adicionais !== undefined) updateData.informacoes_adicionais = params.informacoes_adicionais
      if (params.codigo_servico !== undefined) updateData.codigo_servico = params.codigo_servico
      if (params.discriminacao_servicos !== undefined) updateData.discriminacao_servicos = params.discriminacao_servicos
      if (params.valor_desconto !== undefined) updateData.valor_desconto = params.valor_desconto

      const { data: nota, error } = await supabase
        .from('notas_fiscais')
        .update(updateData)
        .eq('id', params.id)
        .select()
        .single()

      if (error) return { content: [{ type: 'text' as const, text: `Erro ao atualizar: ${error.message}` }] }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, nota }) }] }
    }
  )

  // ── Tool 5: Deletar nota fiscal (rascunho) ──
  server.tool(
    'delete_nota_fiscal',
    'Deleta uma nota fiscal em rascunho. Notas emitidas não podem ser deletadas.',
    {
      id: z.string().describe('ID da nota fiscal'),
    },
    async ({ id }) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()

      const { data: existing } = await supabase
        .from('notas_fiscais')
        .select('id, status')
        .eq('id', id)
        .eq('organization_id', orgId)
        .single()

      if (!existing) return { content: [{ type: 'text' as const, text: 'Nota fiscal não encontrada' }] }
      if ((existing as any).status !== 'rascunho') {
        return { content: [{ type: 'text' as const, text: 'Apenas rascunhos podem ser excluídos' }] }
      }

      // Excluir itens primeiro
      await supabase.from('notas_fiscais_itens').delete().eq('nota_fiscal_id', id)

      const { error } = await supabase
        .from('notas_fiscais')
        .delete()
        .eq('id', id)
        .eq('organization_id', orgId)

      if (error) return { content: [{ type: 'text' as const, text: `Erro ao excluir: ${error.message}` }] }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }] }
    }
  )

  // ── Tool 6: Adicionar item a nota fiscal ──
  server.tool(
    'add_item_nota_fiscal',
    'Adiciona um item a uma nota fiscal em rascunho e recalcula os totais.',
    {
      nota_fiscal_id: z.string().describe('ID da nota fiscal'),
      descricao: z.string().describe('Descricao do item/servico'),
      quantidade: z.number().min(0.01).describe('Quantidade'),
      valor_unitario: z.number().min(0.01).describe('Valor unitario'),
      ncm: z.string().optional().describe('Codigo NCM (para NFe)'),
      cfop: z.string().optional().describe('CFOP (para NFe)'),
      unidade: z.string().optional().default('UN').describe('Unidade (UN, KG, etc)'),
      codigo_servico: z.string().optional().describe('Codigo do servico (para NFSe)'),
      aliquota_iss: z.number().optional().describe('Aliquota ISS % (para NFSe)'),
    },
    async (params) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()

      // Verificar nota
      const { data: nota } = await supabase
        .from('notas_fiscais')
        .select('id, status, tipo')
        .eq('id', params.nota_fiscal_id)
        .eq('organization_id', orgId)
        .single()

      if (!nota) return { content: [{ type: 'text' as const, text: 'Nota fiscal não encontrada' }] }
      if ((nota as any).status !== 'rascunho') {
        return { content: [{ type: 'text' as const, text: 'Apenas rascunhos podem receber itens' }] }
      }

      // Determinar próximo numero_item
      const { data: itensExistentes } = await supabase
        .from('notas_fiscais_itens')
        .select('numero_item')
        .eq('nota_fiscal_id', params.nota_fiscal_id)
        .order('numero_item', { ascending: false })
        .limit(1)

      const proximoNumero = itensExistentes && itensExistentes.length > 0
        ? (itensExistentes[0] as any).numero_item + 1
        : 1

      const valorTotal = params.quantidade * params.valor_unitario
      const now = new Date().toISOString()
      const tipo = (nota as any).tipo

      const itemData: Record<string, any> = {
        nota_fiscal_id: params.nota_fiscal_id,
        numero_item: proximoNumero,
        descricao: params.descricao,
        quantidade: params.quantidade,
        valor_unitario: params.valor_unitario,
        valor_total: valorTotal,
        valor_desconto: 0,
        valor_frete: 0,
        unidade: params.unidade || 'UN',
        ncm: params.ncm || null,
        cfop: params.cfop || (tipo === 'nfe' ? '5102' : null),
        codigo_servico: params.codigo_servico || null,
        aliquota_iss: params.aliquota_iss || 0,
        valor_iss: params.aliquota_iss ? (valorTotal * params.aliquota_iss / 100) : 0,
        icms_origem: 'nacional',
        icms_cst: tipo === 'nfe' ? '102' : null,
        icms_base_calculo: 0,
        icms_aliquota: 0,
        icms_valor: 0,
        pis_cst: '99',
        pis_base_calculo: 0,
        pis_aliquota: 0,
        pis_valor: 0,
        cofins_cst: '99',
        cofins_base_calculo: 0,
        cofins_aliquota: 0,
        cofins_valor: 0,
        created_at: now,
        updated_at: now,
      }

      const { data: item, error } = await supabase
        .from('notas_fiscais_itens')
        .insert(itemData)
        .select()
        .single()

      if (error) return { content: [{ type: 'text' as const, text: `Erro ao adicionar item: ${error.message}` }] }

      // Recalcular totais
      const { data: todosItens } = await supabase
        .from('notas_fiscais_itens')
        .select('*')
        .eq('nota_fiscal_id', params.nota_fiscal_id)

      let valorProdutos = 0
      let valorServicos = 0
      let valorIss = 0

      for (const it of (todosItens || []) as any[]) {
        const v = it.valor_total - (it.valor_desconto || 0)
        if (tipo === 'nfse' || it.codigo_servico) {
          valorServicos += v
          valorIss += it.valor_iss || 0
        } else {
          valorProdutos += v
        }
      }

      const { data: notaAtual } = await supabase
        .from('notas_fiscais')
        .select('valor_desconto, valor_frete, valor_seguro, valor_outras_despesas')
        .eq('id', params.nota_fiscal_id)
        .single()

      const nd = notaAtual as any || {}
      const totalNota = valorProdutos + valorServicos - (nd.valor_desconto || 0) + (nd.valor_frete || 0) + (nd.valor_seguro || 0) + (nd.valor_outras_despesas || 0)

      await supabase
        .from('notas_fiscais')
        .update({
          valor_produtos: valorProdutos,
          valor_servicos: valorServicos,
          valor_iss: valorIss,
          valor_total: totalNota,
          updated_at: now,
        })
        .eq('id', params.nota_fiscal_id)

      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, item, valor_total_nota: totalNota }) }] }
    }
  )

  // ── Tool 7: Cancelar nota fiscal ──
  server.tool(
    'cancel_nota_fiscal',
    'Cancela uma nota fiscal emitida (NFe ou NFSe). Requer justificativa com mínimo 15 caracteres.',
    {
      id: z.string().describe('ID da nota fiscal'),
      justificativa: z.string().min(15).describe('Justificativa do cancelamento (mínimo 15 caracteres)'),
    },
    async ({ id, justificativa }) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()

      // Buscar nota
      const { data: nota } = await supabase
        .from('notas_fiscais')
        .select('*')
        .eq('id', id)
        .eq('organization_id', orgId)
        .single()

      if (!nota) return { content: [{ type: 'text' as const, text: 'Nota fiscal não encontrada' }] }

      const n = nota as any
      if (n.status !== 'autorizada') {
        return { content: [{ type: 'text' as const, text: 'Apenas notas autorizadas podem ser canceladas' }] }
      }
      if (!n.focus_nfe_ref) {
        return { content: [{ type: 'text' as const, text: 'Nota sem referência Focus NFe' }] }
      }

      // Verificar prazo (24h para NFe)
      if (n.tipo === 'nfe') {
        const dataEmissao = new Date(n.data_emissao || n.created_at)
        const diffHoras = (Date.now() - dataEmissao.getTime()) / (1000 * 60 * 60)
        if (diffHoras > 24) {
          return { content: [{ type: 'text' as const, text: 'Prazo de cancelamento expirado (máximo 24 horas após emissão)' }] }
        }
      }

      // Buscar config fiscal
      const { data: config } = await supabase
        .from('fiscal_config')
        .select('*')
        .eq('organization_id', orgId)
        .single()

      if (!config) return { content: [{ type: 'text' as const, text: 'Configuração fiscal não encontrada' }] }

      const cfg = config as any
      const focusToken = resolveFocusToken(cfg)
      const focusApiUrl = resolveFocusApiUrl(cfg)
      const now = new Date().toISOString()

      try {
        const endpoint = n.tipo === 'nfe'
          ? `/v2/nfe/${encodeURIComponent(n.focus_nfe_ref)}`
          : `/v2/nfse/${encodeURIComponent(n.focus_nfe_ref)}`

        const response: any = await focusFetch(endpoint, {
          method: 'DELETE',
          token: focusToken,
          apiUrl: focusApiUrl,
          body: { justificativa },
        })

        let status = n.status
        if (response.status === 'cancelado') status = 'cancelada'

        await supabase
          .from('notas_fiscais')
          .update({
            status,
            cancelada: status === 'cancelada',
            data_cancelamento: status === 'cancelada' ? now : null,
            motivo_cancelamento: justificativa,
            focus_nfe_status: response.status,
            status_sefaz: response.status_sefaz || response.mensagem || null,
            mensagem_sefaz: response.mensagem_sefaz || response.mensagem || null,
            updated_at: now,
          })
          .eq('id', id)

        await supabase.from('fiscal_eventos').insert({
          organization_id: orgId,
          nota_fiscal_id: id,
          tipo: 'cancelamento',
          status: response.status,
          mensagem: response.mensagem_sefaz || response.mensagem || justificativa,
          dados: response,
          created_at: now,
        })

        const { data: notaAtualizada } = await supabase
          .from('notas_fiscais')
          .select('*')
          .eq('id', id)
          .single()

        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, nota: notaAtualizada }) }] }
      } catch (err: any) {
        await supabase.from('fiscal_eventos').insert({
          organization_id: orgId,
          nota_fiscal_id: id,
          tipo: 'erro_cancelamento',
          status: 'erro',
          mensagem: err.message,
          dados: { error: err.message },
          created_at: now,
        })

        return { content: [{ type: 'text' as const, text: `Erro ao cancelar: ${err.message}` }] }
      }
    }
  )

  // ── Tool 8: Carta de correção (NFe) ──
  server.tool(
    'send_carta_correcao',
    'Envia carta de correção para uma NFe autorizada. Texto entre 15 e 1000 caracteres.',
    {
      id: z.string().describe('ID da nota fiscal (NFe)'),
      correcao: z.string().min(15).max(1000).describe('Texto da correção (15-1000 caracteres)'),
    },
    async ({ id, correcao }) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()

      const { data: nota } = await supabase
        .from('notas_fiscais')
        .select('*')
        .eq('id', id)
        .eq('organization_id', orgId)
        .eq('tipo', 'nfe')
        .single()

      if (!nota) return { content: [{ type: 'text' as const, text: 'NFe não encontrada' }] }

      const n = nota as any
      if (n.status !== 'autorizada') {
        return { content: [{ type: 'text' as const, text: 'Carta de correção só pode ser enviada para notas autorizadas' }] }
      }
      if (!n.focus_nfe_ref) {
        return { content: [{ type: 'text' as const, text: 'Nota sem referência Focus NFe' }] }
      }

      const { data: config } = await supabase
        .from('fiscal_config')
        .select('*')
        .eq('organization_id', orgId)
        .single()

      if (!config) return { content: [{ type: 'text' as const, text: 'Configuração fiscal não encontrada' }] }

      const cfg = config as any
      const focusToken = resolveFocusToken(cfg)
      const focusApiUrl = resolveFocusApiUrl(cfg)
      const now = new Date().toISOString()

      try {
        const response: any = await focusFetch(
          `/v2/nfe/${encodeURIComponent(n.focus_nfe_ref)}/carta_correcao`,
          {
            method: 'POST',
            token: focusToken,
            apiUrl: focusApiUrl,
            body: { correcao },
          }
        )

        const updateData: Record<string, any> = { updated_at: now }
        if (response.caminho_xml_carta_correcao) updateData.url_xml_carta_correcao = response.caminho_xml_carta_correcao
        if (response.caminho_pdf_carta_correcao) updateData.url_pdf_carta_correcao = response.caminho_pdf_carta_correcao

        await supabase.from('notas_fiscais').update(updateData).eq('id', id)

        await supabase.from('fiscal_eventos').insert({
          organization_id: orgId,
          nota_fiscal_id: id,
          tipo: 'carta_correcao',
          status: response.status || 'enviado',
          mensagem: correcao,
          dados: response,
          created_at: now,
        })

        const { data: notaAtualizada } = await supabase
          .from('notas_fiscais')
          .select('*')
          .eq('id', id)
          .single()

        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, nota: notaAtualizada }) }] }
      } catch (err: any) {
        await supabase.from('fiscal_eventos').insert({
          organization_id: orgId,
          nota_fiscal_id: id,
          tipo: 'erro_carta_correcao',
          status: 'erro',
          mensagem: err.message,
          dados: { error: err.message, correcao },
          created_at: now,
        })

        return { content: [{ type: 'text' as const, text: `Erro ao enviar carta de correção: ${err.message}` }] }
      }
    }
  )

  // ── Tool 9: Criar nota a partir de orçamento ──
  server.tool(
    'create_nota_from_orcamento',
    'Cria uma nota fiscal (rascunho) a partir de um orçamento aprovado, importando cliente e itens.',
    {
      orcamento_id: z.string().describe('ID do orçamento'),
      tipo: z.enum(['nfe', 'nfse']).describe('Tipo: nfe (produtos) ou nfse (servicos)'),
    },
    async ({ orcamento_id, tipo }) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()

      // Buscar orçamento com cliente
      const { data: orcamento } = await supabase
        .from('orcamentos')
        .select('*, cliente:clientes(*)')
        .eq('id', orcamento_id)
        .eq('organization_id', orgId)
        .single()

      if (!orcamento) return { content: [{ type: 'text' as const, text: 'Orçamento não encontrado' }] }

      const orc = orcamento as any
      if (orc.status !== 'aprovado') {
        return { content: [{ type: 'text' as const, text: 'Apenas orçamentos aprovados podem gerar nota fiscal' }] }
      }

      // Verificar se já existe nota para este orçamento
      const { data: notaExistente } = await supabase
        .from('notas_fiscais')
        .select('id, status')
        .eq('orcamento_id', orcamento_id)
        .eq('tipo', tipo)
        .neq('status', 'cancelada')
        .single()

      if (notaExistente) {
        return { content: [{ type: 'text' as const, text: `Já existe uma ${tipo.toUpperCase()} para este orçamento` }] }
      }

      // Verificar config
      const { data: config } = await supabase
        .from('fiscal_config')
        .select('*')
        .eq('organization_id', orgId)
        .single()

      if (!config) return { content: [{ type: 'text' as const, text: 'Configuração fiscal não encontrada' }] }

      const cfg = config as any
      if (tipo === 'nfe' && !cfg.nfe_habilitado) return { content: [{ type: 'text' as const, text: 'NFe não habilitada' }] }
      if (tipo === 'nfse' && !cfg.nfse_habilitado) return { content: [{ type: 'text' as const, text: 'NFSe não habilitada' }] }

      const now = new Date().toISOString()
      const cliente = orc.cliente
      const cpfCnpj = cliente?.cpf_cnpj?.replace(/\D/g, '') || ''
      const destinatarioTipo = cpfCnpj.length === 14 ? 'pessoa_juridica' : 'pessoa_fisica'

      const notaData: Record<string, any> = {
        organization_id: orgId,
        tipo,
        status: 'rascunho',
        cliente_id: orc.cliente_id,
        orcamento_id,
        destinatario_tipo: destinatarioTipo,
        destinatario_nome: cliente?.nome || orc.cliente_nome,
        destinatario_cpf_cnpj: cpfCnpj || '00000000000',
        destinatario_ie: cliente?.inscricao_estadual || null,
        destinatario_email: cliente?.email || orc.cliente_email,
        destinatario_telefone: cliente?.telefone || cliente?.whatsapp || orc.cliente_telefone,
        destinatario_cep: cliente?.cep || null,
        destinatario_logradouro: cliente?.rua || null,
        destinatario_numero: cliente?.numero || null,
        destinatario_bairro: cliente?.bairro || null,
        destinatario_municipio: cliente?.cidade || null,
        destinatario_uf: cliente?.estado || null,
        natureza_operacao: tipo === 'nfe' ? 'Venda de mercadoria' : 'Prestacao de servico',
        finalidade: 'normal',
        indicador_presenca: 'nao_se_aplica',
        codigo_servico: tipo === 'nfse' ? cfg.nfse_codigo_servico : null,
        discriminacao_servicos: tipo === 'nfse' ? orc.descricao : null,
        local_prestacao_codigo_municipio: cfg.codigo_municipio,
        local_prestacao_municipio: cfg.municipio,
        local_prestacao_uf: cfg.uf,
        iss_retido: false,
        valor_produtos: 0,
        valor_servicos: 0,
        valor_desconto: orc.valor_desconto || 0,
        valor_frete: 0,
        valor_seguro: 0,
        valor_outras_despesas: 0,
        valor_total: 0,
        valor_icms: 0,
        valor_icms_st: 0,
        valor_ipi: 0,
        valor_pis: 0,
        valor_cofins: 0,
        valor_iss: 0,
        valor_ir: 0,
        valor_csll: 0,
        valor_inss: 0,
        created_at: now,
        updated_at: now,
      }

      const { data: nota, error: notaError } = await supabase
        .from('notas_fiscais')
        .insert(notaData)
        .select()
        .single()

      if (notaError) return { content: [{ type: 'text' as const, text: `Erro ao criar nota: ${notaError.message}` }] }

      // Buscar itens do orçamento
      const { data: itensOrcamento } = await supabase
        .from('orcamento_itens')
        .select('*, produto:produtos(*)')
        .eq('orcamento_id', orcamento_id)
        .order('ordem', { ascending: true })

      if (itensOrcamento && itensOrcamento.length > 0) {
        let numeroItem = 0
        const itensNota = []

        for (const itemOrc of itensOrcamento as any[]) {
          numeroItem++
          const produto = itemOrc.produto
          const valorTotal = itemOrc.quantidade * itemOrc.valor_unitario
          const valorDesconto = itemOrc.desconto || 0

          itensNota.push({
            nota_fiscal_id: (nota as any).id,
            numero_item: numeroItem,
            produto_id: itemOrc.produto_id,
            codigo: produto?.id?.substring(0, 8) || String(numeroItem).padStart(3, '0'),
            descricao: itemOrc.descricao,
            ncm: produto?.ncm || null,
            cfop: produto?.cfop_venda || (tipo === 'nfe' ? '5102' : null),
            unidade: produto?.unidade || 'UN',
            quantidade: itemOrc.quantidade,
            valor_unitario: itemOrc.valor_unitario,
            valor_total: valorTotal,
            valor_desconto: valorDesconto,
            valor_frete: 0,
            icms_origem: produto?.origem || 'nacional',
            icms_cst: tipo === 'nfe' ? '102' : null,
            icms_base_calculo: 0,
            icms_aliquota: 0,
            icms_valor: 0,
            pis_cst: '99',
            pis_base_calculo: 0,
            pis_aliquota: 0,
            pis_valor: 0,
            cofins_cst: '99',
            cofins_base_calculo: 0,
            cofins_aliquota: 0,
            cofins_valor: 0,
            codigo_servico: tipo === 'nfse' ? (produto?.codigo_servico || cfg.nfse_codigo_servico) : null,
            aliquota_iss: tipo === 'nfse' ? (produto?.aliquota_iss || cfg.nfse_aliquota_iss || 5) : 0,
            valor_iss: tipo === 'nfse' ? ((valorTotal - valorDesconto) * (produto?.aliquota_iss || cfg.nfse_aliquota_iss || 5)) / 100 : 0,
            created_at: now,
            updated_at: now,
          })
        }

        await supabase.from('notas_fiscais_itens').insert(itensNota)

        // Recalcular totais
        let valorProdutos = 0
        let valorServicos = 0
        let valorIss = 0

        for (const it of itensNota) {
          const v = it.valor_total - it.valor_desconto
          if (tipo === 'nfse' || it.codigo_servico) {
            valorServicos += v
            valorIss += it.valor_iss
          } else {
            valorProdutos += v
          }
        }

        const totalNota = valorProdutos + valorServicos - (orc.valor_desconto || 0)

        await supabase
          .from('notas_fiscais')
          .update({
            valor_produtos: valorProdutos,
            valor_servicos: valorServicos,
            valor_iss: valorIss,
            valor_total: totalNota,
            updated_at: now,
          })
          .eq('id', (nota as any).id)
      }

      // Buscar nota final
      const { data: notaFinal } = await supabase
        .from('notas_fiscais')
        .select('*')
        .eq('id', (nota as any).id)
        .single()

      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, nota: notaFinal || nota }) }] }
    }
  )

  // ── Tool 10: Emitir NFe (produtos) ──
  server.tool(
    'emit_nfe',
    'Emite uma NFe (Nota Fiscal Eletrônica de produtos) via Focus NFe. A nota deve estar em status "rascunho" e ter itens e destinatário preenchidos.',
    {
      nota_id: z.string().describe('ID da nota fiscal a emitir'),
    },
    async ({ nota_id }) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()

      // Buscar nota
      const { data: nota, error: notaErr } = await supabase
        .from('notas_fiscais')
        .select('*')
        .eq('id', nota_id)
        .eq('organization_id', orgId)
        .eq('tipo', 'nfe')
        .single()

      if (notaErr || !nota) {
        return { content: [{ type: 'text' as const, text: 'NFe não encontrada' }] }
      }

      if ((nota as any).status !== 'rascunho') {
        return { content: [{ type: 'text' as const, text: 'Apenas notas em rascunho podem ser emitidas' }] }
      }

      // Buscar itens
      const { data: itens, error: itensErr } = await supabase
        .from('notas_fiscais_itens')
        .select('*')
        .eq('nota_fiscal_id', nota_id)
        .order('numero_item', { ascending: true })

      if (itensErr || !itens || itens.length === 0) {
        return { content: [{ type: 'text' as const, text: 'Nota deve ter pelo menos um item' }] }
      }

      // Buscar configuração fiscal
      const { data: config, error: configErr } = await supabase
        .from('fiscal_config')
        .select('*')
        .eq('organization_id', orgId)
        .single()

      if (configErr || !config) {
        return { content: [{ type: 'text' as const, text: 'Configuração fiscal não encontrada. Configure pelo app web.' }] }
      }

      const cfg = config as any
      if (!cfg.nfe_habilitado) {
        return { content: [{ type: 'text' as const, text: 'NFe não está habilitada na configuração fiscal' }] }
      }

      if (cfg.certificado_validade && new Date(cfg.certificado_validade) < new Date()) {
        return { content: [{ type: 'text' as const, text: 'Certificado digital expirado' }] }
      }

      const n = nota as any

      // Validar destinatário
      if (!n.destinatario_nome || !n.destinatario_cpf_cnpj) {
        return { content: [{ type: 'text' as const, text: 'Dados do destinatário incompletos (nome e CPF/CNPJ obrigatórios)' }] }
      }
      if (!n.destinatario_logradouro || !n.destinatario_municipio || !n.destinatario_uf) {
        return { content: [{ type: 'text' as const, text: 'Endereço do destinatário incompleto' }] }
      }

      const dentroEstado = isMesmoEstado(cfg.uf, n.destinatario_uf)
      const focusRef = generateFocusRef(orgId, 'nfe')

      // Montar itens Focus NFe
      const focusItens = (itens as any[]).map((item, index) => ({
        numero_item: index + 1,
        codigo_produto: item.codigo || item.id.substring(0, 8),
        descricao: item.descricao,
        cfop: item.cfop || getCfopVenda(dentroEstado, false),
        unidade_comercial: item.unidade || 'UN',
        quantidade_comercial: item.quantidade,
        valor_unitario_comercial: item.valor_unitario,
        valor_bruto: item.valor_total,
        ncm: item.ncm || '00000000',
        cest: item.cest || undefined,
        icms_origem: ICMS_ORIGEM_MAP[item.icms_origem || 'nacional'] || '0',
        icms_situacao_tributaria: item.icms_cst || DEFAULT_CSOSN,
        pis_situacao_tributaria: item.pis_cst || PIS_COFINS_CST_SIMPLES,
        cofins_situacao_tributaria: item.cofins_cst || PIS_COFINS_CST_SIMPLES,
      }))

      // Montar payload
      const cpfCnpj = n.destinatario_cpf_cnpj.replace(/\D/g, '')
      const isCnpj = cpfCnpj.length === 14

      const focusPayload: any = {
        natureza_operacao: n.natureza_operacao || 'Venda de mercadoria',
        data_emissao: new Date().toISOString(),
        tipo_documento: 1,
        finalidade_emissao: FINALIDADE_MAP[n.finalidade || 'normal'] || 1,
        consumidor_final: n.destinatario_tipo === 'pessoa_fisica' ? 1 : 0,
        presenca_comprador: PRESENCA_MAP[n.indicador_presenca || 'nao_se_aplica'] || 0,
        nome_destinatario: n.destinatario_nome,
        ...(isCnpj ? { cnpj_destinatario: cpfCnpj } : { cpf_destinatario: cpfCnpj }),
        inscricao_estadual_destinatario: n.destinatario_ie || undefined,
        telefone_destinatario: n.destinatario_telefone?.replace(/\D/g, '') || undefined,
        email_destinatario: n.destinatario_email || undefined,
        logradouro_destinatario: n.destinatario_logradouro,
        numero_destinatario: n.destinatario_numero || 'S/N',
        complemento_destinatario: n.destinatario_complemento || undefined,
        bairro_destinatario: n.destinatario_bairro || 'Centro',
        municipio_destinatario: n.destinatario_municipio,
        uf_destinatario: n.destinatario_uf,
        cep_destinatario: n.destinatario_cep?.replace(/\D/g, '') || '',
        codigo_municipio_destinatario: n.destinatario_codigo_municipio || cfg.codigo_municipio,
        forma_pagamento: [{ forma_pagamento: '90', valor_pagamento: n.valor_total }],
        items: focusItens,
        informacoes_adicionais_contribuinte: n.informacoes_adicionais || undefined,
      }

      const now = new Date().toISOString()

      try {
        // Atualizar status para processando
        await supabase
          .from('notas_fiscais')
          .update({ status: 'processando', focus_nfe_ref: focusRef, updated_at: now })
          .eq('id', nota_id)

        // Enviar para Focus NFe
        const focusToken = resolveFocusToken(cfg)
        const focusApiUrl = resolveFocusApiUrl(cfg)
        const response: any = await focusFetch(`/v2/nfe?ref=${encodeURIComponent(focusRef)}`, {
          method: 'POST',
          token: focusToken,
          apiUrl: focusApiUrl,
          body: focusPayload,
        })

        let status = 'processando'
        if (response.status === 'autorizado') status = 'autorizada'
        else if (response.status === 'erro_autorizacao' || response.status === 'denegado') status = 'rejeitada'

        // Atualizar nota com resultado
        const updateData: Record<string, any> = {
          status,
          serie: response.serie ? parseInt(response.serie, 10) : cfg.nfe_serie,
          chave_acesso: response.chave_nfe || null,
          protocolo: response.protocolo || null,
          focus_nfe_status: response.status,
          status_sefaz: response.status_sefaz || null,
          mensagem_sefaz: response.mensagem_sefaz || null,
          url_xml: response.caminho_xml_nota_fiscal || null,
          url_danfe: response.caminho_danfe || null,
          updated_at: now,
        }

        if (status === 'autorizada') {
          updateData.data_emissao = now
          if (response.numero) {
            updateData.numero = parseInt(response.numero, 10)
            await supabase
              .from('fiscal_config')
              .update({ nfe_ultimo_numero: parseInt(response.numero, 10), updated_at: now })
              .eq('organization_id', orgId)
          }
        }

        await supabase.from('notas_fiscais').update(updateData).eq('id', nota_id)

        // Registrar evento
        await supabase.from('fiscal_eventos').insert({
          organization_id: orgId,
          nota_fiscal_id: nota_id,
          tipo: 'emissao',
          status: response.status,
          mensagem: response.mensagem_sefaz || 'NFe enviada para processamento',
          dados: response,
          created_at: now,
        })

        // Buscar nota atualizada
        const { data: notaAtualizada } = await supabase
          .from('notas_fiscais')
          .select('*')
          .eq('id', nota_id)
          .single()

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true, nota: notaAtualizada, focus_status: response.status }),
          }],
        }
      } catch (err: any) {
        // Reverter status
        await supabase
          .from('notas_fiscais')
          .update({ status: 'erro', mensagem_sefaz: err.message, updated_at: now })
          .eq('id', nota_id)

        await supabase.from('fiscal_eventos').insert({
          organization_id: orgId,
          nota_fiscal_id: nota_id,
          tipo: 'erro',
          status: 'erro',
          mensagem: err.message,
          dados: { error: err.message },
          created_at: now,
        })

        return { content: [{ type: 'text' as const, text: `Erro ao emitir NFe: ${err.message}` }] }
      }
    }
  )

  // ── Tool 4: Emitir NFSe (serviços) ──
  server.tool(
    'emit_nfse',
    'Emite uma NFSe (Nota Fiscal de Serviço Eletrônica) via Focus NFe. A nota deve estar em status "rascunho".',
    {
      nota_id: z.string().describe('ID da nota fiscal a emitir'),
    },
    async ({ nota_id }) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()

      // Buscar nota
      const { data: nota, error: notaErr } = await supabase
        .from('notas_fiscais')
        .select('*')
        .eq('id', nota_id)
        .eq('organization_id', orgId)
        .eq('tipo', 'nfse')
        .single()

      if (notaErr || !nota) {
        return { content: [{ type: 'text' as const, text: 'NFSe não encontrada' }] }
      }

      if ((nota as any).status !== 'rascunho') {
        return { content: [{ type: 'text' as const, text: 'Apenas notas em rascunho podem ser emitidas' }] }
      }

      // Buscar configuração fiscal
      const { data: config, error: configErr } = await supabase
        .from('fiscal_config')
        .select('*')
        .eq('organization_id', orgId)
        .single()

      if (configErr || !config) {
        return { content: [{ type: 'text' as const, text: 'Configuração fiscal não encontrada. Configure pelo app web.' }] }
      }

      const cfg = config as any
      if (!cfg.nfse_habilitado) {
        return { content: [{ type: 'text' as const, text: 'NFSe não está habilitada na configuração fiscal' }] }
      }

      const n = nota as any

      if (!n.destinatario_nome || !n.destinatario_cpf_cnpj) {
        return { content: [{ type: 'text' as const, text: 'Dados do tomador incompletos' }] }
      }

      const focusRef = generateFocusRef(orgId, 'nfse')
      const cpfCnpj = n.destinatario_cpf_cnpj.replace(/\D/g, '')
      const isCnpj = cpfCnpj.length === 14

      const focusPayload: any = {
        data_emissao: new Date().toISOString(),
        natureza_operacao: '1', // Tributação no município
        prestador: {
          cnpj: cfg.cnpj?.replace(/\D/g, ''),
          inscricao_municipal: cfg.inscricao_municipal,
          codigo_municipio: cfg.codigo_municipio,
        },
        tomador: {
          ...(isCnpj ? { cnpj: cpfCnpj } : { cpf: cpfCnpj }),
          razao_social: n.destinatario_nome,
          email: n.destinatario_email || undefined,
          telefone: n.destinatario_telefone?.replace(/\D/g, '') || undefined,
          endereco: {
            logradouro: n.destinatario_logradouro || '',
            numero: n.destinatario_numero || 'S/N',
            complemento: n.destinatario_complemento || '',
            bairro: n.destinatario_bairro || '',
            codigo_municipio: n.destinatario_codigo_municipio || cfg.codigo_municipio,
            uf: n.destinatario_uf || cfg.uf,
            cep: n.destinatario_cep?.replace(/\D/g, '') || '',
          },
        },
        servico: {
          aliquota: n.aliquota_iss || cfg.nfse_aliquota_iss || 0,
          discriminacao: n.discriminacao_servicos || n.informacoes_adicionais || 'Prestação de serviços',
          iss_retido: n.iss_retido ? 'true' : 'false',
          item_lista_servico: n.codigo_servico || cfg.nfse_codigo_servico || '',
          valor_servicos: n.valor_total,
        },
      }

      const now = new Date().toISOString()

      try {
        await supabase
          .from('notas_fiscais')
          .update({ status: 'processando', focus_nfe_ref: focusRef, updated_at: now })
          .eq('id', nota_id)

        const focusToken = resolveFocusToken(cfg)
        const focusApiUrl = resolveFocusApiUrl(cfg)
        const response: any = await focusFetch(`/v2/nfse?ref=${encodeURIComponent(focusRef)}`, {
          method: 'POST',
          token: focusToken,
          apiUrl: focusApiUrl,
          body: focusPayload,
        })

        let status = 'processando'
        if (response.status === 'autorizado') status = 'autorizada'
        else if (response.status === 'erro_autorizacao') status = 'rejeitada'

        const updateData: Record<string, any> = {
          status,
          focus_nfe_status: response.status,
          mensagem_sefaz: response.mensagem || null,
          url_xml: response.caminho_xml_nota_fiscal || null,
          url_pdf: response.url || null,
          updated_at: now,
        }

        if (status === 'autorizada') {
          updateData.data_emissao = now
          if (response.numero) {
            updateData.numero = parseInt(response.numero, 10)
            await supabase
              .from('fiscal_config')
              .update({ nfse_ultimo_numero: parseInt(response.numero, 10), updated_at: now })
              .eq('organization_id', orgId)
          }
        }

        await supabase.from('notas_fiscais').update(updateData).eq('id', nota_id)

        await supabase.from('fiscal_eventos').insert({
          organization_id: orgId,
          nota_fiscal_id: nota_id,
          tipo: 'emissao',
          status: response.status,
          mensagem: response.mensagem || 'NFSe enviada para processamento',
          dados: response,
          created_at: now,
        })

        const { data: notaAtualizada } = await supabase
          .from('notas_fiscais')
          .select('*')
          .eq('id', nota_id)
          .single()

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true, nota: notaAtualizada, focus_status: response.status }),
          }],
        }
      } catch (err: any) {
        await supabase
          .from('notas_fiscais')
          .update({ status: 'erro', mensagem_sefaz: err.message, updated_at: now })
          .eq('id', nota_id)

        await supabase.from('fiscal_eventos').insert({
          organization_id: orgId,
          nota_fiscal_id: nota_id,
          tipo: 'erro',
          status: 'erro',
          mensagem: err.message,
          dados: { error: err.message },
          created_at: now,
        })

        return { content: [{ type: 'text' as const, text: `Erro ao emitir NFSe: ${err.message}` }] }
      }
    }
  )
}
