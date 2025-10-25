import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch"; // Node 18+ já tem fetch nativo, mas mantemos para compatibilidade
import dotenv from "dotenv";

dotenv.config(); // Para ler variáveis de ambiente do .env

// 1️⃣ Configura Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// 2️⃣ Configura Zaia
const zaiaApiUrl = process.env.ZAIA_API_URL;
const zaiaToken = process.env.ZAIA_TOKEN;

async function fetchContactsZaia() {
  try {
    const response = await fetch(`${zaiaApiUrl}/contacts`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${zaiaToken}`,
        "Content-Type": "application/json"
      }
    });

    const data = await response.json();
    if (!Array.isArray(data.contacts)) {
      throw new Error("Formato inesperado da resposta da Zaia");
    }

    console.log(`📌 Encontrados ${data.contacts.length} contatos no WhatsApp`);
    return data.contacts;
  } catch (err) {
    console.error("❌ Falha ao buscar contatos da Zaia:", err);
    return [];
  }
}

async function importContacts() {
  const contacts = await fetchContactsZaia();

  for (const c of contacts) {
    const phone_number = c.phone;
    const nome = c.name || "Sem nome";
    const etiqueta = c.tag || null;

    try {
      // Verifica se o cliente já existe no Supabase
      const { data: existing } = await supabase
        .from("clientes")
        .select("*")
        .eq("phone_number", phone_number)
        .single();

      if (existing) {
        // Atualiza etiqueta caso tenha mudado
        if (etiqueta && existing.etiqueta_whatsapp !== etiqueta) {
          await supabase
            .from("clientes")
            .update({ etiqueta_whatsapp: etiqueta })
            .eq("phone_number", phone_number);
          console.log(`🔄 Atualizada etiqueta de ${phone_number} para "${etiqueta}"`);
        } else {
          console.log(`✔ Cliente já existente: ${phone_number}`);
        }
        continue;
      }

      // Insere novo cliente
      await supabase.from("clientes").insert([{
        nome,
        phone_number,
        etiqueta_whatsapp: etiqueta,
        importado_zaia: true
      }]);
      console.log(`✅ Importado novo cliente: ${phone_number} (${nome})`);

    } catch (err) {
      console.error(`⚠️ Erro ao processar cliente ${phone_number}:`, err);
    }
  }

  console.log("🏁 Importação concluída!");
}

// Executa
importContacts();
