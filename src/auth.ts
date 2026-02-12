import { createHash } from 'node:crypto'
import { getSupabase } from './supabase.js'

/**
 * Resolve organization_id a partir de uma API key.
 *
 * @param apiKey        — API key (HTTP header) ou process.env.GV_API_KEY (STDIO)
 * @param orgIdOverride — Org ID explícito via header X-Org-Id (só funciona com MASTER_API_KEY)
 *
 * Prioridade para MASTER_API_KEY:
 *   1. orgIdOverride (header X-Org-Id)
 *   2. process.env.GV_ORG_ID
 *   3. null (cross-tenant)
 *
 * API keys normais IGNORAM orgIdOverride (segurança: não troca de org).
 */
export async function resolveOrgId(apiKey?: string, orgIdOverride?: string): Promise<string | null> {
  const key = apiKey || process.env.GV_API_KEY

  if (!key) {
    throw new Error('API key é obrigatória (GV_API_KEY ou header Authorization)')
  }

  // Master key: acesso cross-tenant (ou scoped via X-Org-Id / GV_ORG_ID)
  const masterKey = process.env.MASTER_API_KEY
  if (masterKey && key === masterKey) {
    const orgId = orgIdOverride || process.env.GV_ORG_ID
    if (orgId) {
      console.error(`[auth] MASTER_API_KEY com org: ${orgId}`)
      return orgId
    }
    console.error('[auth] Usando MASTER_API_KEY (cross-tenant)')
    return null
  }

  // Hash SHA-256 da key
  const keyHash = createHash('sha256').update(key).digest('hex')

  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('api_keys')
    .select('organization_id')
    .eq('key_hash', keyHash)
    .eq('active', true)
    .single()

  if (error || !data) {
    throw new Error('API key inválida — verifique a chave e tente novamente')
  }

  console.error(`[auth] Autenticado para org: ${data.organization_id}`)
  return data.organization_id as string
}
