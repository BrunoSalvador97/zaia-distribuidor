import { createClient } from "@supabase/supabase-js";

// Compatível Node 18+ ou versões antigas com node-fetch
let fetchFunction;
try {
  fetchFunction = fetch; // Node 18+
} catch {
  fetchFunction = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
}

export default async function handler(req, res) {
  console.log("🔹 Início da função distribuidor", { method: req.method });

  if (req.method !== "POST") return res.status(405).json({ error: "Método não permitido" });

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;

    if (!supabaseUrl || !supabaseKey)
      return res.status(500).json({ error: "Configuração do Supabase ausente" });

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Lê body enviado pelo Webhook Universal Zaia
    let body = req.body;
    if (!body || Object.keys(body).length === 0) {
      try {
        body = JSON.parse(req.body);
      } catch {
        return res.status(400).json({ error: "Body inválido" });
      }
    }

    // Zaia envia os dados dentro de "eventData"
    const eventData = body?.eventData || body;
    const phone_number = eventData.phone_number || eventData.from || eventData.sender;
    const nome = eventData.nome || eventData.name || "Cliente";
    const empresa = eventData.empresa || "Não informado";
    const cidade = eventData.cidade || "Não informado";
    const tipo_midia = eventData.tipo_midia || null;
    const periodo = eventData.periodo || null;
    const orcamento = eventData.orcamento || null;
    const mensagens = eventData.mensagens || (eventData.text ? [{ text: eventData.text, origem: "cliente" }] : []);

    if (!phone_number) return res.status(400).json({ error: "Número de telefone obrigatório" });
    if (!nome) return res.status(400).json({ error: "Nome do cliente obrigatório" });
    if (!empresa) return res.status(400).json({ error: "Nome da empresa obrigatório" });

    // ✅ Correção da relação com a tabela vendedores
    const { data: existing } = await supabase
      .from("clientes")
      .select("*, vendedor:vendedor_id(nome, etiqueta_whatsapp, telefone)")
      .eq("phone_number", phone_number)
      .single();

    if (existing) {
      // Salva mensagens do lead no histórico
      if (mensagens && Array.isArray(mensagens)) {
        for (let msg of mensagens) {
          await supabase.from("mensagens_leads").insert([{
            cliente_id: existing.id,
            mensagem: msg.text,
            origem: msg.origem || "cliente"
          }]);
        }
      }

      // ✅ Envia novamente a mensagem resumida ao vendedor original
      const mensagemResumo = `
📞 Lead retornou ao atendimento!

Nome: ${nome}
Empresa: ${empresa}
Telefone: ${phone_number}
Cidade: ${cidade || "Não informado"}
Última mensagem: ${mensagens?.[0]?.text || "Sem mensagem recente"}
`;

      try {
        await fetchFunction(`${process.env.ZAIA_API_URL}/messages/send`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.ZAIA_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            to: existing.vendedor?.telefone,
            type: "text",
            text: mensagemResumo
          })
        });

        console.log("📩 Mensagem enviada ao vendedor original.");
      } catch (err) {
        console.error("⚠️ Falha ao enviar mensagem do cliente antigo:", err);
      }

      return res.status(200).json({
        tipo: "antigo",
        vendedor_id: existing.vendedor_id,
        vendedor_nome: existing.vendedor?.nome || "Desconhecido",
        mensagem: `Cliente antigo redirecionado para ${existing.vendedor?.nome || "vendedor"}`
      });
    }

    // Busca vendedores ativos
    const { data: vendedores } = await supabase
      .from("vendedores")
      .select("*")
      .eq("ativo", true)
      .order("id", { ascending: true });

    if (!vendedores || vendedores.length === 0)
      return res.status(500).json({ error: "Nenhum vendedor ativo encontrado" });

    // Índice da roleta
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
        nome, empresa, phone_number, cidade, tipo_midia, periodo, orcamento,
        vendedor_id: vendedorEscolhido.id
      }])
      .select();

    if (insertError) throw insertError;

    const clienteId = novoCliente[0].id;

    // Salva mensagens enviadas pelo lead
    if (mensagens && Array.isArray(mensagens)) {
      for (let msg of mensagens) {
        await supabase.from("mensagens_leads").insert([{
          cliente_id: clienteId,
          mensagem: msg.text,
          origem: msg.origem || "cliente"
        }]);
      }
    }

    // Monta mensagem resumida
    const mensagemResumo = `
🚀 Novo lead qualificado!

Nome: ${nome}
Empresa: ${empresa}
Resumo da conversa:
- Cidade: ${cidade || "Não informado"}
- Telefone: ${phone_number}
- Tipo de mídia: ${tipo_midia || "Não informado"}
- Período: ${periodo || "Não informado"}
- Orçamento: ${orcamento || "Não informado"}
`;

    // Envia pelo número principal da Zaia, mas para o vendedor correto
    try {
      // Aplica etiqueta ao lead
      await fetchFunction(`${process.env.ZAIA_API_URL}/contacts/tag`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.ZAIA_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ phone: phone_number, tag: vendedorEscolhido.etiqueta_whatsapp })
      });

      // Envia mensagem para o vendedor pelo número principal
      await fetchFunction(`${process.env.ZAIA_API_URL}/messages/send`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.ZAIA_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          to: vendedorEscolhido.telefone,
          type: "text",
          text: mensagemResumo
        })
      });

      console.log("📌 Lead enviado via número principal ao vendedor correto");
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
