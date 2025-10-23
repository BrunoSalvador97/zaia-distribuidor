import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  console.log("🔹 Início da função distribuidor", {
    method: req.method,
    body: req.body,
  });

  if (req.method !== "POST") {
    console.warn("⚠️ Método não permitido:", req.method);
    return res.status(405).json({ error: "Método não permitido" });
  }

  try {
    // Cria cliente Supabase
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      console.error("❌ Variáveis de ambiente do Supabase faltando!");
      return res
        .status(500)
        .json({ error: "Configuração do Supabase ausente" });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    console.log("✅ Cliente Supabase criado com sucesso.");

    const { phone_number, nome } = req.body;
    console.log("📞 Dados recebidos:", { phone_number, nome });

    if (!phone_number) {
      console.error("❌ Número de telefone não informado!");
      return res.status(400).json({ error: "Número de telefone obrigatório" });
    }

    // 1️⃣ Verifica se o cliente já existe
    const { data: existing, error: existingError } = await supabase
      .from("clientes")
      .select("*")
      .eq("phone_number", phone_number)
      .single();

    if (existingError && existingError.code !== "PGRST116") {
      // PGRST116 = "No rows found"
      console.error("⚠️ Erro ao consultar cliente:", existingError);
      throw existingError;
    }

    if (existing) {
      console.log("👤 Cliente antigo identificado:", existing.nome);
      return res.status(200).json({
        tipo: "antigo",
        vendedor_id: existing.vendedor_id,
        mensagem: "Cliente antigo redirecionado ao vendedor original",
      });
    }

    // 2️⃣ Busca todos os vendedores
    const { data: vendedores, error: vendError } = await supabase
      .from("vendedores")
      .select("*")
      .order("id", { ascending: true });

    if (vendError) {
      console.error("❌ Erro ao buscar vendedores:", vendError);
      throw vendError;
    }

    console.log("👥 Vendedores carregados:", vendedores.map((v) => v.nome));

    // 3️⃣ Busca total de clientes para calcular distribuição
    const { data: totalClientes } = await supabase
      .from("clientes")
      .select("vendedor_id");

    const contagem = vendedores.map((v) => ({
      ...v,
      total:
        totalClientes?.filter((c) => c.vendedor_id === v.id).length || 0,
    }));

    console.log("📊 Distribuição atual:", contagem);

    // 4️⃣ Escolhe o vendedor com menos clientes
    const vendedorEscolhido = contagem.sort((a, b) => a.total - b.total)[0];

    console.log("🎯 Vendedor selecionado:", vendedorEscolhido.nome);

    // 5️⃣ Insere novo cliente
    const { data: novoCliente, error: insertError } = await supabase
      .from("clientes")
      .insert([
        {
          nome: nome || "Sem nome",
          phone_number,
          vendedor_id: vendedorEscolhido.id,
        },
      ])
      .select();

    if (insertError) {
      console.error("❌ Erro ao inserir novo cliente:", insertError);
      throw insertError;
    }

    console.log("✅ Novo cliente registrado:", novoCliente);

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
