import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  console.log("🔹 Início da função distribuidor");
  console.log("req.method:", req.method);
  console.log("req.headers:", req.headers);

  if (req.method !== "POST") {
    console.warn("⚠️ Método não permitido:", req.method);
    return res.status(405).json({ error: "Método não permitido" });
  }

  try {
    // Configuração Supabase
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      console.error("❌ Variáveis de ambiente do Supabase ausentes!");
      return res.status(500).json({ error: "Configuração do Supabase ausente" });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    console.log("✅ Cliente Supabase criado com sucesso.");

    // Garantir que o body seja lido corretamente
    let body = req.body;
    if (!body || Object.keys(body).length === 0) {
      try {
        body = JSON.parse(req.body);
      } catch (err) {
        console.error("❌ Body inválido:", req.body);
        return res.status(400).json({ error: "Body inválido" });
      }
    }

    console.log("📦 Body recebido:", body);

    const { phone_number, nome } = body;

    if (!phone_number) {
      console.error("❌ Número de telefone não informado!");
      return res.status(400).json({ error: "Número de telefone obrigatório" });
    }

    // 1️⃣ Verifica se cliente já existe
    const { data: existing, error: existingError } = await supabase
      .from("clientes")
      .select("*")
      .eq("phone_number", phone_number)
      .single();

    if (existingError && existingError.code !== "PGRST116") {
      console.error("⚠️ Erro ao consultar cliente:", existingError);
      throw existingError;
    }

    if (existing) {
      console.log("👤 Cliente antigo identificado:", existing.nome);
      return res.status(200).json({
        tipo: "antigo",
        vendedor_id: existing.vendedor_id,
        vendedor_nome: existing.nome_vendedor,
        mensagem: "Cliente antigo redirecionado ao vendedor original",
      });
    }

    console.log("🆕 Cliente novo, procedendo com distribuição.");

    // 2️⃣ Busca todos os vendedores
    const { data: vendedores, error: vendError } = await supabase
      .from("vendedores")
      .select("*")
      .order("id", { ascending: true });

    if (vendError) {
      console.error("❌ Erro ao buscar vendedores:", vendError);
      throw vendError;
    }

    console.log("👥 Vendedores disponíveis:", vendedores.map(v => v.nome));

    // 3️⃣ Conta clientes por vendedor
    const { data: totalClientes } = await supabase.from("clientes").select("vendedor_id");
    const contagem = vendedores.map(v => ({
      ...v,
      total: totalClientes.filter(c => c.vendedor_id === v.id).length,
    }));

    console.log("📊 Distribuição atual de clientes:", contagem);

    // 4️⃣ Escolhe vendedor com menos clientes
    const vendedorEscolhido = contagem.sort((a, b) => a.total - b.total)[0];
    console.log("🎯 Vendedor selecionado:", vendedorEscolhido.nome);

    // 5️⃣ Insere novo cliente
    const { data: novoCliente, error: insertError } = await supabase
      .from("clientes")
      .insert([{
        nome: nome || "Sem nome",
        phone_number,
        vendedor_id: vendedorEscolhido.id,
        nome_vendedor: vendedorEscolhido.nome,
        telefone_vendedor: vendedorEscolhido.telefone,
      }])
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
