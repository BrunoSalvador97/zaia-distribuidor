import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  console.log("🔹 Início da função distribuidor", { method: req.method });

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  try {
    // 1️⃣ Cria cliente Supabase
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      console.error("❌ Variáveis de ambiente do Supabase faltando!");
      return res.status(500).json({ error: "Configuração do Supabase ausente" });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // 2️⃣ Lê o body corretamente
    let body = req.body;
    if (!body || Object.keys(body).length === 0) {
      try {
        body = JSON.parse(req.body);
      } catch {
        console.error("❌ Body inválido", req.body);
        return res.status(400).json({ error: "Body inválido" });
      }
    }

    const { phone_number, nome } = body;
    if (!phone_number) {
      console.error("❌ Número de telefone não informado!");
      return res.status(400).json({ error: "Número de telefone obrigatório" });
    }

    // 3️⃣ Verifica se o cliente já existe
    const { data: existing } = await supabase
      .from("clientes")
      .select("*, vendedores(nome, etiqueta_whatsapp) as vendedor")
      .eq("phone_number", phone_number)
      .single();

    if (existing) {
      console.log("👤 Cliente antigo identificado:", { nome_cliente: existing.nome, vendedor_id: existing.vendedor_id });
      return res.status(200).json({
        tipo: "antigo",
        vendedor_id: existing.vendedor_id,
        vendedor_nome: existing.vendedor?.nome || "Desconhecido",
        mensagem: `Cliente antigo redirecionado para ${existing.vendedor?.nome || "vendedor"}`,
      });
    }

    // 4️⃣ Busca todos os vendedores ativos
    const { data: vendedores } = await supabase
      .from("vendedores")
      .select("*")
      .eq("ativo", true)
      .order("id", { ascending: true });

    if (!vendedores || vendedores.length === 0) {
      return res.status(500).json({ error: "Nenhum vendedor ativo encontrado" });
    }

    // 5️⃣ Pega índice da roleta
    const { data: config } = await supabase.from("config").select("*").eq("id", 1).single();
    let index = config?.ultimo_vendedor_index ?? 0;

    // 6️⃣ Escolhe vendedor da roleta
    const vendedorEscolhido = vendedores[index % vendedores.length];

    // 7️⃣ Atualiza índice da roleta
    await supabase.from("config").update({
      ultimo_vendedor_index: (index + 1) % vendedores.length,
      atualizado_em: new Date()
    }).eq("id", 1);

    // 8️⃣ Insere novo cliente
    const { data: novoCliente, error: insertError } = await supabase
      .from("clientes")
      .insert([{ nome: nome || "Sem nome", phone_number, vendedor_id: vendedorEscolhido.id }])
      .select();

    if (insertError) throw insertError;

    console.log("✅ Novo cliente registrado:", {
      nome_cliente: nome,
      vendedor_id: vendedorEscolhido.id,
      vendedor_nome: vendedorEscolhido.nome,
      etiqueta_whatsapp: vendedorEscolhido.etiqueta_whatsapp,
    });

    // 9️⃣ Aplica etiqueta WhatsApp via API Zaia (fetch nativo)
    try {
      const response = await fetch(`${process.env.ZAIA_API_URL}/contacts/tag`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.ZAIA_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          phone: phone_number,
          tag: vendedorEscolhido.etiqueta_whatsapp
        })
      });

      const result = await response.json();
      console.log("📌 Etiqueta aplicada no WhatsApp:", result);
    } catch (err) {
      console.error("⚠️ Falha ao aplicar etiqueta no WhatsApp:", err);
    }

    // 10️⃣ Retorna sucesso
    return res.status(200).json({
      tipo: "novo",
      vendedor_id: vendedorEscolhido.id,
      vendedor_nome: vendedorEscolhido.nome,
      etiqueta_whatsapp: vendedorEscolhido.etiqueta_whatsapp,
      mensagem: `Novo cliente atribuído a ${vendedorEscolhido.nome} e etiqueta aplicada`
    });

  } catch (err) {
    console.error("🔥 Erro geral no distribuidor:", err);
    return res.status(500).json({ error: err.message });
  }
}
