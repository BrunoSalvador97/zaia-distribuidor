import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  console.log("🔹 Início do relatório", { method: req.method });

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      console.error("❌ Variáveis de ambiente do Supabase faltando!");
      return res.status(500).json({ error: "Configuração do Supabase ausente" });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const { vendedor_id, etiqueta, data_inicio, data_fim } = req.query;

    // Query incluindo histórico de mensagens
    let query = supabase
      .from("clientes")
      .select(`
        id,
        nome,
        empresa,
        phone_number,
        cidade,
        tipo_midia,
        periodo,
        orcamento,
        criado_em,
        vendedor_id,
        vendedores!inner(nome, etiqueta_whatsapp),
        mensagens_leads(*)
      `);

    // Aplica filtros
    if (vendedor_id) query = query.eq("vendedor_id", parseInt(vendedor_id));
    if (etiqueta) query = query.ilike("vendedores.etiqueta_whatsapp", `%${etiqueta}%`);
    if (data_inicio) query = query.gte("criado_em", new Date(data_inicio).toISOString());
    if (data_fim) query = query.lte("criado_em", new Date(data_fim).toISOString());

    // Executa query
    const { data: clientes, error } = await query.order("criado_em", { ascending: false });
    if (error) throw error;

    // Estatísticas por vendedor e etiqueta
    const statsVendedores = {};
    const statsEtiquetas = {};
    clientes.forEach(c => {
      const nomeVendedor = c.vendedores?.nome || "Desconhecido";
      const etiquetaVendedor = c.vendedores?.etiqueta_whatsapp || "Sem etiqueta";
      statsVendedores[nomeVendedor] = (statsVendedores[nomeVendedor] || 0) + 1;
      statsEtiquetas[etiquetaVendedor] = (statsEtiquetas[etiquetaVendedor] || 0) + 1;
    });

    // Resumo dos clientes com histórico de mensagens
    const clientesResumo = clientes.map(c => ({
      nome: c.nome,
      empresa: c.empresa,
      telefone: c.phone_number,
      cidade: c.cidade || "Não informado",
      tipo_midia: c.tipo_midia || "Não informado",
      periodo: c.periodo || "Não informado",
      orcamento: c.orcamento || "Não informado",
      data_cadastro: c.criado_em,
      vendedor: c.vendedores?.nome || "Desconhecido",
      etiqueta: c.vendedores?.etiqueta_whatsapp || "Sem etiqueta",
      conversas: c.mensagens_leads?.map(m => ({
        mensagem: m.mensagem,
        timestamp: m.criado_em
      })) || []
    }));

    return res.status(200).json({
      totalClientes: clientes.length,
      statsVendedores,
      statsEtiquetas,
      clientes: clientesResumo,
      mensagem: "Relatório gerado com sucesso"
    });

  } catch (err) {
    console.error("🔥 Erro no relatório:", err);
    return res.status(500).json({ error: err.message });
  }
}
