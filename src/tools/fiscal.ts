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

  // ── Tool 3: Emitir NFe (produtos) ──
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
