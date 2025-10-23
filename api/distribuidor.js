import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  console.log("🔹 Início da função distribuidor", { method: req.method });

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  try {
    // Cria cliente Supabase
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      console.error("❌ Variáveis de ambiente do Supabase faltando!");
      return res.status(500).json({ error: "Configuração do Supabase ausente" });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Garantir que o body seja lido corretamente
    let body = req.body;
    if (!body || Object.keys(body).length === 0) {
      try {
        body = JSON.parse(req.body);
      } catch (err) {
        console.error("❌ Body inválido", req.body);
        return res.status(400).json({ error: "Body inválido" });
      }
    }

    const { phone_number, nome } = body;

    if (!phone_number) {
      console.error("❌ Número de telefone não informado!");
      return res.status(400).json({ error: "Número de telefone obrigatório" });
    }

    // 1️⃣ Verifica se o cliente já existe
    const { data: existing, error: existingError } = await supabase
      .from("clientes")
      .select("*, vendedores(nome) as vendedor")
      .eq("phone_number", phone_number)
      .single();

    if (existingError && existingError.code !== "PGRST116") throw existingError;

    if (existing) {
      console.log(
        "👤 Cliente antigo identificado:",
        { nome_cliente: existing.nome, vendedor_id: existing.vendedor_id }
      );

      // Buscar nome do vendedor para log e resposta
      const { data: vendedorData } = await supabase
        .from("vendedores")
        .select("nome")
        .eq("id", existing.vendedor_id)
        .single();

      return res.status(200).json({
        tipo: "antigo",
        vendedor_id: existing.vendedor_id,
        vendedor_nome: vendedorData?.nome || "Desconhecido",
        mensagem: `Cliente antigo redirecionado para ${vendedorData?.nome || "vendedor"}`,
      });
    }

    // 2️⃣ Busca todos os vendedores
    const { data: vendedores } = await supabase
      .from("vendedores")
      .select("*")
      .order("id", { ascending: true });

    // 3️⃣ Conta clientes por vendedor
    const { data: totalClientes } = await supabase.from("clientes").select("vendedor_id");
    const contagem = vendedores.map(v => ({
      ...v,
      total: totalClientes.filter(c => c.vendedor_id === v.id).length,
    }));

    // 4️⃣ Escolhe vendedor com menos clientes
    const vendedorEscolhido = contagem.sort((a, b) => a.total - b.total)[0];

    // 5️⃣ Insere novo cliente
    const { data: novoCliente, error: insertError } = await supabase
      .from("clientes")
      .insert([
        {
          nome: nome || "Sem nome",
          phone_number,
          vendedor_id: vendedorEscolhido.id
        },
      ])
      .select();

    if (insertError) throw insertError;

    console.log("✅ Novo cliente registrado:", {
      nome_cliente: nome,
      vendedor_id: vendedorEscolhido.id,
      vendedor_nome: vendedorEscolhido.nome,
    });

    return res.status(200).json({
      tipo: "novo",
      vendedor_id: vendedorEscolhido.id,
      vendedor_nome: vendedorEscolhido.nome,
      mensagem: `Novo cliente atribuído a ${vendedorEscolhido.nome}`,
    });

  } catch (err) {
    console.error("🔥 Erro geral no distribuidor:", err);
    return res.status(500).json({ error: err.message });
  }
}
