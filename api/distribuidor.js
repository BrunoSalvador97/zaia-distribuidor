import { createClient } from "@supabase/supabase-js";

// 1. Inicialização do Supabase fora do handler para reutilização de conexão (Warm Start)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Configuração do Supabase ausente. Verifique as variáveis de ambiente.");
  // Em um ambiente Vercel, isto deve ser tratado na construção, mas é uma boa verificação.
}

const supabase = createClient(supabaseUrl, supabaseKey);

// 2. Função auxiliar para chamadas à API Zaia com melhor tratamento de erro
async function callZaiaApi(endpoint, body) {
  const url = `${process.env.ZAIA_API_URL}${endpoint}`;
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
    throw new Error(`Falha na API Zaia (Status: ${response.status}) para ${endpoint}: ${errorBody}`);
  }

  return response.json();
}

export default async function handler(req, res) {
  console.log("🔹 Início da função distribuidor", { method: req.method });

  if (req.method !== "POST") return res.status(405).json({ error: "Método não permitido" });

  // 3. Verifica se a conexão com Supabase está configurada
  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: "Configuração do Supabase ausente" });
  }

  try {
    // 4. Simplificação do parsing do body (confiando no Vercel/Next.js)
    const body = req.body;
    if (!body || Object.keys(body).length === 0) {
      // Se o body estiver vazio por algum motivo, retorna erro.
      return res.status(400).json({ error: "Body inválido ou vazio" });
    }

    // Mapeamento de dados do Zaia
    const eventData = body?.eventData || body;
    const phone_number = eventData.phone_number || eventData.from || eventData.sender;
    const nome = eventData.nome || eventData.name || "Cliente";
    const empresa = eventData.empresa || "Não informado";
    const cidade = eventData.cidade || "Não informado";
    const tipo_midia = eventData.tipo_midia || null;
    const periodo = eventData.periodo || null;
    const orcamento = eventData.orcamento || null;
    const mensagens = eventData.mensagens || (eventData.text ? [{ text: eventData.text, origem: "cliente" }] : []);

    // Validações
    if (!phone_number) return res.status(400).json({ error: "Número de telefone obrigatório" });
    // As validações de nome e empresa (Linhas 47-49) podem ser removidas se o Zaia garantir esses dados
    // ou se o valor "Não informado" for aceitável.

    // ------------------------------------------------------------------------------------------------
    // LÓGICA DE CLIENTE EXISTENTE
    // ------------------------------------------------------------------------------------------------

    const { data: existing, error: fetchError } = await supabase
      .from("clientes")
      .select("*, vendedor:vendedor_id(nome, etiqueta_whatsapp, telefone)")
      .eq("phone_number", phone_number)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') { // PGRST116 = Nenhum resultado encontrado (OK)
        throw fetchError;
    }

    if (existing) {
      // Salva mensagens do lead no histórico
      if (mensagens && Array.isArray(mensagens)) {
        const messagesToInsert = mensagens.map(msg => ({
            cliente_id: existing.id,
            mensagem: msg.text,
            origem: msg.origem || "cliente"
        }));
        // Otimização: Inserção em lote
        await supabase.from("mensagens_leads").insert(messagesToInsert);
      }

      // Envia mensagem resumida ao vendedor original
      const mensagemResumo = `
📞 Lead retornou ao atendimento!

Nome: ${nome}
Empresa: ${empresa}
Telefone: ${phone_number}
Cidade: ${cidade || "Não informado"}
Última mensagem: ${mensagens?.[0]?.text || "Sem mensagem recente"}
`;

      try {
        await callZaiaApi("/messages/send", {
            to: existing.vendedor?.telefone,
            type: "text",
            text: mensagemResumo
        });
        console.log("📩 Mensagem enviada ao vendedor original.");
      } catch (err) {
        console.error("⚠️ Falha ao enviar mensagem do cliente antigo:", err.stack);
      }

      return res.status(200).json({
        tipo: "antigo",
        vendedor_id: existing.vendedor_id,
        vendedor_nome: existing.vendedor?.nome || "Desconhecido",
        mensagem: `Cliente antigo redirecionado para ${existing.vendedor?.nome || "vendedor"}`
      });
    }

    // ------------------------------------------------------------------------------------------------
    // LÓGICA DE NOVO CLIENTE (ROUND-ROBIN)
    // ------------------------------------------------------------------------------------------------

    // Busca vendedores ativos e configuração de índice em paralelo (Otimização)
    const [
      { data: vendedores, error: vendError },
      { data: config, error: configError }
    ] = await Promise.all([
      supabase.from("vendedores").select("id, nome, etiqueta_whatsapp, telefone").eq("ativo", true).order("id", { ascending: true }),
      supabase.from("config").select("ultimo_vendedor_index").eq("id", 1).single()
    ]);

    if (vendError) throw vendError;
    if (configError && configError.code !== 'PGRST116') throw configError;

    if (!vendedores || vendedores.length === 0)
      return res.status(500).json({ error: "Nenhum vendedor ativo encontrado" });

    let index = config?.ultimo_vendedor_index ?? 0;
    const vendedorEscolhido = vendedores[index % vendedores.length];

    // Atualiza índice da roleta
    await supabase.from("config").update({
      ultimo_vendedor_index: (index + 1) % vendedores.length,
      atualizado_em: new Date().toISOString()
    }).eq("id", 1);

    // Insere novo cliente
    const { data: novoCliente, error: insertError } = await supabase
      .from("clientes")
      .insert([{
        nome, empresa, phone_number, cidade, tipo_midia, periodo, orcamento,
        vendedor_id: vendedorEscolhido.id
      }])
      .select("id")
      .single(); // Otimização: usar single() se espera apenas um resultado

    if (insertError) throw insertError;

    const clienteId = novoCliente.id;

    // Salva mensagens enviadas pelo lead (Otimização: Inserção em lote)
    if (mensagens && Array.isArray(mensagens)) {
        const messagesToInsert = mensagens.map(msg => ({
            cliente_id: clienteId,
            mensagem: msg.text,
            origem: msg.origem || "cliente"
        }));
        await supabase.from("mensagens_leads").insert(messagesToInsert);
    }

    // Monta mensagem resumida
    const mensagemResumo = `
🚀 Novo lead qualificado!

Vendedor: ${vendedorEscolhido.nome}
Nome: ${nome}
Empresa: ${empresa}
Resumo da conversa:
- Cidade: ${cidade || "Não informado"}
- Telefone: ${phone_number}
- Tipo de mídia: ${tipo_midia || "Não informado"}
- Período: ${periodo || "Não informado"}
- Orçamento: ${orcamento || "Não informado"}
`;

    // Envia pelo número principal da Zaia
    try {
      // Aplica etiqueta ao lead
      await callZaiaApi("/contacts/tag", {
          phone: phone_number,
          tag: vendedorEscolhido.etiqueta_whatsapp
      });

      // Envia mensagem para o vendedor pelo número principal
      await callZaiaApi("/messages/send", {
          to: vendedorEscolhido.telefone,
          type: "text",
          text: mensagemResumo
      });

      console.log("📌 Lead enviado via número principal ao vendedor correto");
    } catch (err) {
      console.error("⚠️ Falha ao aplicar etiqueta ou enviar mensagem:", err.stack);
    }

    return res.status(200).json({
      tipo: "novo",
      vendedor_id: vendedorEscolhido.id,
      vendedor_nome: vendedorEscolhido.nome,
      etiqueta_whatsapp: vendedorEscolhido.etiqueta_whatsapp,
      mensagem: `Novo cliente atribuído a ${vendedorEscolhido.nome} e resumo enviado`
    });

  } catch (err) {
    console.error("🔥 Erro geral no distribuidor:", err.stack || err.message);
    return res.status(500).json({ error: err.message });
  }
}