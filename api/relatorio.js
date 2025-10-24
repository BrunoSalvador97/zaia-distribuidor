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

    // 1️⃣ Monta query básica
    let query = supabase
      .from("clientes")
      .select(`
        id,
        nome,
        phone_number,
        vendedor_id,
        created_at,
        vendedores!inner(nome, etiqueta_whatsapp)
      `);

    // 2️⃣ Aplica filtros
    if (vendedor_id) query = query.eq("vendedor_id", parseInt(vendedor_id));
    if (etiqueta) query = query.ilike("vendedores.etiqueta_whatsapp", `%${etiqueta}%`);
    if (data_inicio) query = query.gte("created_at", new Date(data_inicio).toISOString());
    if (data_fim) query = query.lte("created_at", new Date(data_fim).toISOString());

    // 3️⃣ Executa query
    const { data: clientes, error } = await query.order("created_at", { ascending: false });
    if (error) throw error;

    // 4️⃣ Calcula estatísticas por vendedor e etiqueta
    const statsVendedores = {};
    const statsEtiquetas = {};

    clientes.forEach(c => {
      const nomeVendedor = c.vendedores?.nome || "Desconhecido";
      const etiquetaVendedor = c.vendedores?.etiqueta_whatsapp || "Sem etiqueta";

      statsVendedores[nomeVendedor] = (statsVendedores[nomeVendedor] || 0) + 1;
      statsEtiquetas[etiquetaVendedor] = (statsEtiquetas[etiquetaVendedor] || 0) + 1;
    });

    // 5️⃣ Retorna resultado
    return res.status(200).json({
      totalClientes: clientes.length,
      statsVendedores,
      statsEtiquetas,
      clientes,
      mensagem: "Relatório gerado com sucesso"
    });

  } catch (err) {
    console.error("🔥 Erro no relatório:", err);
    return res.status(500).json({ error: err.message });
  }
}
