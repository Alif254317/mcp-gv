import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getSupabase } from '../supabase.js'

export function registerFornecedoresTools(server: McpServer, orgId: string | null) {
  // ── Tool 1: Listar fornecedores ──
  server.tool(
    'list_fornecedores',
    'Lista fornecedores cadastrados com busca por nome, CNPJ, telefone ou email e paginação',
    {
      busca: z.string().optional().describe('Busca por nome, CPF/CNPJ, telefone ou email (parcial)'),
      page: z.number().min(1).default(1),
      limit: z.number().min(1).max(100).default(20),
    },
    async ({ busca, page, limit }) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()
      let query = supabase
        .from('fornecedores')
        .select('*', { count: 'exact' })
        .eq('organization_id', orgId)

      if (busca) {
        query = query.or(`nome.ilike.%${busca}%,cpf_cnpj.ilike.%${busca}%,telefone.ilike.%${busca}%,email.ilike.%${busca}%`)
      }

      const from = (page - 1) * limit
      const { data, count, error } = await query
        .order('nome', { ascending: true })
        .range(from, from + limit - 1)

      if (error) return { content: [{ type: 'text' as const, text: `Erro: ${error.message}` }] }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ data: data || [], total: count ?? 0, page, limit }) }] }
    }
  )

  // ── Tool 2: Buscar fornecedor por ID ──
  server.tool(
    'get_fornecedor',
    'Busca um fornecedor pelo ID',
    {
      id: z.string().describe('ID (UUID) do fornecedor'),
    },
    async ({ id }) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()
      const { data, error } = await supabase
        .from('fornecedores')
        .select('*')
        .eq('id', id)
        .eq('organization_id', orgId)
        .maybeSingle()

      if (error) return { content: [{ type: 'text' as const, text: `Erro: ${error.message}` }] }
      if (!data) return { content: [{ type: 'text' as const, text: JSON.stringify({ found: false }) }] }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ found: true, fornecedor: data }) }] }
    }
  )

  // ── Tool 3: Criar fornecedor ──
  server.tool(
    'create_fornecedor',
    'Cria um novo fornecedor',
    {
      nome: z.string().describe('Nome do fornecedor (obrigatório)'),
      tipo: z.enum(['pessoa_fisica', 'pessoa_juridica']).default('pessoa_juridica').describe('Tipo: pessoa_fisica ou pessoa_juridica'),
      cpf_cnpj: z.string().optional().describe('CPF ou CNPJ'),
      email: z.string().optional().describe('Email'),
      telefone: z.string().optional().describe('Telefone'),
      whatsapp: z.string().optional().describe('WhatsApp'),
      cep: z.string().optional().describe('CEP'),
      rua: z.string().optional().describe('Rua/Logradouro'),
      numero: z.string().optional().describe('Número'),
      bairro: z.string().optional().describe('Bairro'),
      cidade: z.string().optional().describe('Cidade'),
      estado: z.string().optional().describe('Estado (UF)'),
      observacoes: z.string().optional().describe('Observações'),
    },
    async (params) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()
      const { data, error } = await supabase
        .from('fornecedores')
        .insert({
          organization_id: orgId,
          nome: params.nome.trim(),
          tipo: params.tipo,
          cpf_cnpj: params.cpf_cnpj || null,
          email: params.email || null,
          telefone: params.telefone || null,
          whatsapp: params.whatsapp || null,
          cep: params.cep || null,
          rua: params.rua || null,
          numero: params.numero || null,
          bairro: params.bairro || null,
          cidade: params.cidade || null,
          estado: params.estado || null,
          observacoes: params.observacoes || null,
        })
        .select()
        .single()

      if (error) return { content: [{ type: 'text' as const, text: `Erro: ${error.message}` }] }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, fornecedor: data }) }] }
    }
  )

  // ── Tool 4: Atualizar fornecedor ──
  server.tool(
    'update_fornecedor',
    'Atualiza um fornecedor existente',
    {
      id: z.string().describe('ID (UUID) do fornecedor'),
      nome: z.string().optional().describe('Nome'),
      tipo: z.enum(['pessoa_fisica', 'pessoa_juridica']).optional().describe('Tipo'),
      cpf_cnpj: z.string().optional().describe('CPF ou CNPJ'),
      email: z.string().optional().describe('Email'),
      telefone: z.string().optional().describe('Telefone'),
      whatsapp: z.string().optional().describe('WhatsApp'),
      cep: z.string().optional().describe('CEP'),
      rua: z.string().optional().describe('Rua'),
      numero: z.string().optional().describe('Número'),
      bairro: z.string().optional().describe('Bairro'),
      cidade: z.string().optional().describe('Cidade'),
      estado: z.string().optional().describe('Estado (UF)'),
      observacoes: z.string().optional().describe('Observações'),
    },
    async ({ id, ...fields }) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      // Build update object with only provided fields
      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) updates[key] = value
      }

      const supabase = getSupabase()
      const { data, error } = await supabase
        .from('fornecedores')
        .update(updates)
        .eq('id', id)
        .eq('organization_id', orgId)
        .select()
        .single()

      if (error) return { content: [{ type: 'text' as const, text: `Erro: ${error.message}` }] }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, fornecedor: data }) }] }
    }
  )

  // ── Tool 5: Deletar fornecedor ──
  server.tool(
    'delete_fornecedor',
    'Remove um fornecedor pelo ID',
    {
      id: z.string().describe('ID (UUID) do fornecedor'),
    },
    async ({ id }) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()
      const { error } = await supabase
        .from('fornecedores')
        .delete()
        .eq('id', id)
        .eq('organization_id', orgId)

      if (error) return { content: [{ type: 'text' as const, text: `Erro: ${error.message}` }] }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, deleted_id: id }) }] }
    }
  )
}
