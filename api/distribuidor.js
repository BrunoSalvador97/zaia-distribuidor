import { createClient } from "@supabase/supabase-js";

// =========================================
// 1. Inicialização do Supabase
// =========================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("⚠️ Configuração do Supabase ausente. Verifique as variáveis de ambiente.");
}

const supabase = createClient(supabaseUrl, supabaseKey);

// =========================================
// 2. Função auxiliar para chamadas à API Zaia (WhatsApp Business Oficial)
// =========================================
async function callZaiaApi(body) {
  const url = `${process.env.ZAIA_API_URL}/whatsapp-business/messages`; // endpoint correto
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.ZAIA_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Falha na API Zaia (Status: ${response.status}): ${errorBody}`);
  }

  return response.json();
}

// =========================================
// 3. Função principal - Distribuidor de leads
// =========================================
export default async function handler(req, res) {
  console.log("🔹 Início da função distribuidor", { method: req.method });

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  try {
    const body = req.body;
    if (!body || Object.keys(body).length === 0) {
      return res.status(400).json({ error: "Body inválido ou vazio" });
    }

    // ==============================
    // Mapeamento de dados do lead
    // ==============================
    const eventData = body?.eventData || body;
    const phone_number = eventData.phone_number || eventData.from || eventData.sender;
    const nome = eventData.nome || "Cliente";
    const empresa = eventData.empresa || "Não informado";
    const cidade = eventData.cidade || "Não informado";
    const tipo_midia = eventData.tipo_midia || "Não informado";
    const periodo = eventData.periodo || "Não informado";
    const orcamento = eventData.orcamento || "Não informado";

    if (!phone_number) {
      return res.status(400).json({ error: "Número de telefone obrigatório" });
    }

    // =============================================
    // CLIENTE EXISTENTE
    // =============================================
    const { data: existing, error: fetchError } = await supabase
      .from("clientes")
      .select("*, vendedor:vendedor_id(nome, telefone)")
      .eq("phone_number", phone_number)
      .single();

    if (fetchError && fetchError.code !== "PGRST116") throw fetchError;

    if (existing) {
      const mensagemResumo = `📞 Lead retornou ao atendimento!\n\nNome: ${nome}\nEmpresa: ${empresa}\nTelefone: ${phone_number}\nCidade: ${cidade}\nTipo de mídia: ${tipo_midia}\nPeríodo: ${periodo}\nOrçamento: ${orcamento}`;

      try {
        await callZaiaApi({
          to: existing.vendedor?.telefone,
          type: "text",
          text: { body: mensagemResumo }
        });
        console.log(`📩 Lead antigo redirecionado para ${existing.vendedor?.nome}`);
      } catch (err) {
        console.error("⚠️ Falha ao notificar vendedor do lead antigo:", err.message);
      }

      return res.status(200).json({
        tipo: "antigo",
        vendedor_id: existing.vendedor_id,
        vendedor_nome: existing.vendedor?.nome || "Desconhecido",
        mensagem: `Cliente antigo redirecionado para ${existing.vendedor?.nome}`
      });
    }

    // =============================================
    // NOVO CLIENTE - ROUND ROBIN
    // =============================================
    const [
      { data: vendedores, error: vendError },
      { data: config, error: configError }
    ] = await Promise.all([
      supabase
        .from("vendedores")
        .select("id, nome, telefone")
        .eq("ativo", true)
        .order("id", { ascending: true }),
      supabase.from("config").select("ultimo_vendedor_index").eq("id", 1).single()
    ]);

    if (vendError) throw vendError;
    if (configError && configError.code !== "PGRST116") throw configError;

    if (!vendedores || vendedores.length === 0) {
      return res.status(500).json({ error: "Nenhum vendedor ativo encontrado" });
    }

    let index = config?.ultimo_vendedor_index ?? 0;
    const vendedorEscolhido = vendedores[index % vendedores.length];

    await supabase
      .from("config")
      .update({ ultimo_vendedor_index: (index + 1) % vendedores.length, atualizado_em: new Date().toISOString() })
      .eq("id", 1);

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
      .select("id")
      .single();

    if (insertError) throw insertError;

    // =============================================
    // Mensagem de resumo para o vendedor (WhatsApp Business Oficial)
    // =============================================
    const mensagemResumo = `🚀 Novo lead qualificado!\n\nVendedor: ${vendedorEscolhido.nome}\nNome: ${nome}\nEmpresa: ${empresa}\nCidade: ${cidade}\nTelefone: ${phone_number}\nTipo de mídia: ${tipo_midia}\nPeríodo: ${periodo}\nOrçamento: ${orcamento}`;

    try {
      await callZaiaApi({
        to: vendedorEscolhido.telefone,
        type: "text",
        text: { body: mensagemResumo }
      });
      console.log(`📌 Lead enviado ao vendedor ${vendedorEscolhido.nome}`);
    } catch(err) {
      console.error("⚠️ Falha ao enviar resumo:", err.message);
    }

    return res.status(200).json({
      tipo: "novo",
      vendedor_id: vendedorEscolhido.id,
      vendedor_nome: vendedorEscolhido.nome,
      mensagem: `Novo lead atribuído a ${vendedorEscolhido.nome} e resumo enviado.`
    });

  } catch (err) {
    console.error("🔥 Erro geral no distribuidor:", err.stack || err.message);
    return res.status(500).json({ error: err.message });
  }
}
