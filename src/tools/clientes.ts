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

  // ── Tool 3: Criar cliente ──
  server.tool(
    'create_cliente',
    'Cria um novo cliente',
    {
      nome: z.string().describe('Nome do cliente (obrigatório)'),
      tipo: z.enum(['pessoa_fisica', 'pessoa_juridica']).default('pessoa_fisica').describe('Tipo: pessoa_fisica ou pessoa_juridica'),
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
        .from('clientes')
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

      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, cliente: data }) }] }
    }
  )

  // ── Tool 3b: Cadastro em lote ──
  server.tool(
    'bulk_create_clientes',
    'Cadastra multiplos clientes de uma vez (importacao em lote via CSV/Excel). Max 500 por chamada.',
    {
      clientes: z.array(z.object({
        nome: z.string().describe('Nome do cliente (obrigatório)'),
        tipo: z.enum(['pessoa_fisica', 'pessoa_juridica']).default('pessoa_fisica'),
        cpf_cnpj: z.string().optional(),
        email: z.string().optional(),
        telefone: z.string().optional(),
        whatsapp: z.string().optional(),
        cep: z.string().optional(),
        rua: z.string().optional(),
        numero: z.string().optional(),
        bairro: z.string().optional(),
        cidade: z.string().optional(),
        estado: z.string().optional(),
        observacoes: z.string().optional(),
      })).min(1).max(500).describe('Array de clientes para cadastrar'),
    },
    async ({ clientes }) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()
      const rows = clientes.map(c => ({
        organization_id: orgId,
        nome: c.nome.trim(),
        tipo: c.tipo ?? 'pessoa_fisica',
        cpf_cnpj: c.cpf_cnpj || null,
        email: c.email || null,
        telefone: c.telefone || null,
        whatsapp: c.whatsapp || null,
        cep: c.cep || null,
        rua: c.rua || null,
        numero: c.numero || null,
        bairro: c.bairro || null,
        cidade: c.cidade || null,
        estado: c.estado || null,
        observacoes: c.observacoes || null,
      }))

      // Insert in chunks of 100 for safety
      const chunkSize = 100
      let cadastrados = 0
      const erros: { index: number; nome: string; erro: string }[] = []

      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize)
        const { data, error } = await supabase
          .from('clientes')
          .insert(chunk)
          .select('id')

        if (error) {
          // If batch fails, try one-by-one to identify which ones fail
          for (let j = 0; j < chunk.length; j++) {
            const { error: singleErr } = await supabase
              .from('clientes')
              .insert(chunk[j])
              .select('id')
              .single()

            if (singleErr) {
              erros.push({ index: i + j, nome: chunk[j].nome, erro: singleErr.message })
            } else {
              cadastrados++
            }
          }
        } else {
          cadastrados += data?.length ?? chunk.length
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ total_enviados: clientes.length, cadastrados, erros }),
        }],
      }
    }
  )

  // ── Tool 4: Atualizar cliente ──
  server.tool(
    'update_cliente',
    'Atualiza um cliente existente',
    {
      id: z.string().describe('ID (UUID) do cliente'),
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

      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) updates[key] = value
      }

      const supabase = getSupabase()
      const { data, error } = await supabase
        .from('clientes')
        .update(updates)
        .eq('id', id)
        .eq('organization_id', orgId)
        .select()
        .single()

      if (error) return { content: [{ type: 'text' as const, text: `Erro: ${error.message}` }] }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, cliente: data }) }] }
    }
  )

  // ── Tool 5: Deletar cliente ──
  server.tool(
    'delete_cliente',
    'Remove um cliente pelo ID',
    {
      id: z.string().describe('ID (UUID) do cliente'),
    },
    async ({ id }) => {
      if (!orgId) return { content: [{ type: 'text' as const, text: 'Erro: orgId obrigatório' }] }

      const supabase = getSupabase()
      const { error } = await supabase
        .from('clientes')
        .delete()
        .eq('id', id)
        .eq('organization_id', orgId)

      if (error) return { content: [{ type: 'text' as const, text: `Erro: ${error.message}` }] }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, deleted_id: id }) }] }
    }
  )
}
