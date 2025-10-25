import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";

export default async function handler(req, res) {
  console.log("🔹 Início da função distribuidor (realtime)", { method: req.method });

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;
    const zaiaToken = process.env.ZAIA_TOKEN;
    const zaiaApi = process.env.ZAIA_API_URL;

    if (!supabaseUrl || !supabaseKey || !zaiaToken || !zaiaApi) {
      console.error("❌ Variáveis de ambiente faltando!");
      return res.status(500).json({ error: "Configuração ausente" });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Lê body
    let body = req.body;
    if (!body || Object.keys(body).length === 0) {
      try {
        body = JSON.parse(req.body);
      } catch {
        console.error("❌ Body inválido", req.body);
        return res.status(400).json({ error: "Body inválido" });
      }
    }

    // Extrai informações do lead do body enviado pelo fluxo Zaia
    const { usuario, empresa, localizacao, tipo_midia, periodo, orcamento } = body;
    const phone_number = usuario?.telefone;
    const nome = usuario?.nome;
    const cidade = localizacao?.cidade || "Não informado";

    if (!phone_number || !nome || !empresa) {
      console.error("❌ Dados obrigatórios faltando!", { phone_number, nome, empresa });
      return res.status(400).json({ error: "Dados obrigatórios faltando" });
    }

    // Verifica se o cliente já existe
    const { data: existing } = await supabase
      .from("clientes")
      .select("*, vendedores(nome, etiqueta_whatsapp, whatsapp) as vendedor")
      .eq("phone_number", phone_number)
      .single();

    if (existing) {
      console.log("👤 Cliente antigo identificado:", { nome_cliente: existing.nome, vendedor_id: existing.vendedor_id });
      return res.status(200).json({
        tipo: "antigo",
        vendedor_id: existing.vendedor_id,
        vendedor_nome: existing.vendedor?.nome || "Desconhecido",
        mensagem: `Cliente antigo redirecionado para ${existing.vendedor?.nome || "vendedor"}`
      });
    }

    // Busca todos os vendedores ativos
    const { data: vendedores } = await supabase
      .from("vendedores")
      .select("*")
      .eq("ativo", true)
      .order("id", { ascending: true });

    if (!vendedores || vendedores.length === 0) {
      return res.status(500).json({ error: "Nenhum vendedor ativo encontrado" });
    }

    // Pega índice da roleta
    const { data: config } = await supabase.from("config").select("*").eq("id", 1).single();
    let index = config?.ultimo_vendedor_index ?? 0;

    const vendedorEscolhido = vendedores[index % vendedores.length];

    // Atualiza índice da roleta
    await supabase.from("config").update({
      ultimo_vendedor_index: (index + 1) % vendedores.length,
      atualizado_em: new Date()
    }).eq("id", 1);

    // Insere novo cliente
    const { data: novoCliente, error: insertError } = await supabase
      .from("clientes")
      .insert([{
        nome,
        empresa,
        phone_number,
        cidade,
        tipo_midia,
        periodo,
        orcamento,
        vendedor_id: vendedorEscolhido.id
      }])
      .select();

    if (insertError) throw insertError;

    console.log("✅ Novo cliente registrado:", {
      nome_cliente: nome,
      vendedor_id: vendedorEscolhido.id,
      vendedor_nome: vendedorEscolhido.nome,
      etiqueta_whatsapp: vendedorEscolhido.etiqueta_whatsapp
    });

    // Monta mensagem resumida
    const mensagemResumo = `
🚀 Novo lead qualificado!

Nome: ${nome}
Empresa: ${empresa}
Resumo da conversa:
- Cidade: ${cidade}
- Telefone: ${phone_number}
- Tipo de mídia: ${tipo_midia || "Não informado"}
- Período: ${periodo || "Não informado"}
- Orçamento: ${orcamento || "Não informado"}
`;

    // Aplica etiqueta e envia mensagem
    try {
      await fetch(`${zaiaApi}/contacts/tag`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${zaiaToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          phone: phone_number,
          tag: vendedorEscolhido.etiqueta_whatsapp
        })
      });

      await fetch(`${zaiaApi}/messages/send`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${zaiaToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          to: vendedorEscolhido.whatsapp || vendedorEscolhido.phone_number,
          type: "text",
          text: mensagemResumo
        })
      });

      console.log("📌 Lead enviado com resumo padronizado ao vendedor");
    } catch (err) {
      console.error("⚠️ Falha ao aplicar etiqueta ou enviar mensagem:", err);
    }

    return res.status(200).json({
      tipo: "novo",
      vendedor_id: vendedorEscolhido.id,
      vendedor_nome: vendedorEscolhido.nome,
      etiqueta_whatsapp: vendedorEscolhido.etiqueta_whatsapp,
      mensagem: `Novo cliente atribuído a ${vendedorEscolhido.nome} e resumo enviado`
    });

  } catch (err) {
    console.error("🔥 Erro geral no distribuidor:", err);
    return res.status(500).json({ error: err.message });
  }
}
