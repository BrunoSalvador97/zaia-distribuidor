import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
)

export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Método não permitido' })

  const { phone_number } = req.body
  if (!phone_number)
    return res.status(400).json({ error: 'Número não informado' })

  const { data: existing } = await supabase
    .from('clientes')
    .select('*')
    .eq('telefone', phone_number)
    .single()

  if (existing) {
    return res.json({
      is_new_client: false,
      assigned_seller: {
        id: existing.vendedor_id,
        name: existing.nome_vendedor,
        phone: existing.telefone_vendedor
      }
    })
  }

  const { data: sellers } = await supabase
    .from('vendedores')
    .select('*')
    .order('id', { ascending: true })

  const { data: lastClient } = await supabase
    .from('clientes')
    .select('vendedor_id')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  let nextSeller = sellers[0]
  if (lastClient) {
    const lastId = lastClient.vendedor_id
    const nextIndex = (lastId % sellers.length)
    nextSeller = sellers[nextIndex]
  }

  const { error } = await supabase.from('clientes').insert({
    telefone: phone_number,
    vendedor_id: nextSeller.id,
    nome_vendedor: nextSeller.nome,
    telefone_vendedor: nextSeller.telefone
  })

  if (error) return res.status(500).json({ error: error.message })

  return res.json({
    is_new_client: true,
    assigned_seller: {
      id: nextSeller.id,
      name: nextSeller.nome,
      phone: nextSeller.telefone
    }
  })
}
