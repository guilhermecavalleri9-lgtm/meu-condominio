// ═══════════════════════════════════════════════════════════════════════════════
// STORE — guarda os dados do app (chave → JSON)
// ═══════════════════════════════════════════════════════════════════════════════
// Dois modos, escolhidos pelas variáveis de ambiente:
//   • arquivo  (padrão): grava em dados/ dentro da pasta do app. Simples, funciona
//                        no computador da portaria sem depender de nada.
//   • supabase (quando SUPABASE_URL + SUPABASE_KEY existem): grava na tabela
//                        portaria_kv, pra não perder nada quando o servidor é
//                        reiniciado numa hospedagem que apaga o disco.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const https = require('https');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'dados');

// Aceita o endereço do jeito que a pessoa colou: com espaço sobrando, entre aspas,
// com barra no fim ou sem o "https://" na frente. Um valor torto aqui derrubava
// o app inteiro com "Invalid URL" em cada pedido.
function arrumarUrl(bruto) {
  let u = String(bruto || '').trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '');
  if (!u) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'https://' + u;
  let parsed;
  try { parsed = new URL(u); } catch (e) { return null; }   // null = não é endereço
  // postgresql://... é a connection string do banco, não o endereço da API
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  return u;
}

// as duas variáveis são fáceis de inverter na pressa; reconhecer o formato evita
// horas de erro obscuro (e impede o servidor de sair tentando resolver a chave como host)
function pareceChave(v) { return /^(sb_(secret|publishable)_|eyJ)/.test(String(v || '').trim()); }
function pareceUrl(v) { return /supabase\.(co|in)|^https?:\/\//i.test(String(v || '').trim()); }

const SUPABASE_URL = pareceChave(process.env.SUPABASE_URL) ? null : arrumarUrl(process.env.SUPABASE_URL);
const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').trim().replace(/^["']|["']$/g, '');
const TABELA = (process.env.SUPABASE_TABELA || 'portaria_kv').trim();
const usandoSupabase = !!(SUPABASE_URL && SUPABASE_KEY);

// erro de configuração tem que aparecer na subida, não em cada pedido
const problemaConfig =
  (pareceChave(process.env.SUPABASE_URL) || (SUPABASE_KEY && pareceUrl(SUPABASE_KEY) && !pareceChave(SUPABASE_KEY)))
    ? 'SUPABASE_URL e SUPABASE_KEY parecem trocadas: a URL deve ser https://xxxx.supabase.co e a KEY a service_role (começa com sb_secret_ ou eyJ)'
  : (process.env.SUPABASE_URL && SUPABASE_URL === null)
    ? 'SUPABASE_URL não é um endereço https válido. Use o Project URL (https://xxxx.supabase.co), não a connection string do banco (postgresql://...)'
  : (process.env.SUPABASE_URL && !process.env.SUPABASE_KEY)
    ? 'SUPABASE_URL foi definida mas falta a SUPABASE_KEY'
  : (process.env.SUPABASE_KEY && !process.env.SUPABASE_URL)
    ? 'SUPABASE_KEY foi definida mas falta a SUPABASE_URL'
  : null;

// cache em memória: leitura instantânea e menos ida ao banco
const memoria = new Map();

// ─── modo arquivo ─────────────────────────────────────────────────────────────
function caminhoDe(chave) {
  const seguro = String(chave).replace(/[^a-zA-Z0-9:_-]/g, '_').replace(/:/g, '__');
  return path.join(DATA_DIR, seguro + '.json');
}

// erro de dado ilegível: quem chamou PRECISA saber a diferença entre
// "ainda não existe" e "existe mas não consegui ler" — tratar os dois como
// vazio já apagou contas antes.
class DadoIlegivel extends Error {
  constructor(chave, causa) {
    super('não consegui ler "' + chave + '": ' + causa);
    this.name = 'DadoIlegivel';
    this.chave = chave;
  }
}

async function lerJson(arquivo) {
  let bruto;
  try {
    bruto = await fsp.readFile(arquivo, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { existe: false, valor: null };   // nunca foi gravado
    throw e;
  }
  try { return { existe: true, valor: JSON.parse(bruto) }; }
  catch (e) { return { existe: true, valor: null, quebrado: bruto }; }
}

async function arquivoGet(chave) {
  const destino = caminhoDe(chave);
  const principal = await lerJson(destino);
  if (!principal.existe) return null;               // primeira vez, tudo bem
  if (principal.valor !== null) return principal.valor;

  // arquivo existe mas está ilegível: tenta a cópia anterior antes de desistir
  console.error('[store] arquivo de "' + chave + '" está corrompido — tentando a cópia de segurança');
  const copia = await lerJson(destino + '.bak');
  if (copia.existe && copia.valor !== null) {
    // guarda o quebrado pra investigação e volta pra cópia boa
    try { await fsp.rename(destino, destino + '.quebrado-' + Date.now()); } catch (e) {}
    try { await fsp.copyFile(destino + '.bak', destino); } catch (e) {}
    console.error('[store] recuperado de "' + chave + '.bak"');
    return copia.valor;
  }
  throw new DadoIlegivel(chave, 'json inválido e sem cópia de segurança utilizável');
}

// Uma gravação por vez em cada chave. Sem isso, dois pedidos ao mesmo tempo
// (entrar + salvar tema, aprovar + bipar) escreviam no mesmo arquivo temporário:
// um estourava erro e o outro deixava o arquivo pela metade.
const _fila = new Map();
function naFila(chave, tarefa) {
  const anterior = _fila.get(chave) || Promise.resolve();
  const agora = anterior.catch(() => {}).then(tarefa);
  _fila.set(chave, agora);
  // limpa a fila quando ela termina, pra não segurar promessas velhas na memória
  agora.catch(() => {}).finally(() => { if (_fila.get(chave) === agora) _fila.delete(chave); });
  return agora;
}

let _contador = 0;
async function arquivoSet(chave, valor) {
  return naFila(chave, async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const destino = caminhoDe(chave);
    // nome único por gravação: nunca duas escrevendo no mesmo temporário
    const temp = destino + '.tmp' + process.pid + '-' + (++_contador) + '-' + Math.random().toString(36).slice(2, 8);
    const texto = JSON.stringify(valor);
    // relê antes de trocar: se der ruim no meio, ainda existe a versão anterior
    try { await fsp.copyFile(destino, destino + '.bak'); } catch (e) { /* primeira gravação */ }
    try {
      await fsp.writeFile(temp, texto, 'utf8');
      await fsp.rename(temp, destino);              // troca atômica
    } catch (e) {
      try { await fsp.unlink(temp); } catch (e2) {}
      throw e;
    }
  });
}
async function arquivoDel(chave) {
  return naFila(chave, async () => {
    try { await fsp.unlink(caminhoDe(chave)); } catch (e) {}
    try { await fsp.unlink(caminhoDe(chave) + '.bak'); } catch (e) {}
  });
}

// ─── modo supabase ────────────────────────────────────────────────────────────
function supabaseReq(metodo, caminho, corpo) {
  return new Promise((resolve, reject) => {
    const u = new URL(SUPABASE_URL + caminho);
    const buf = corpo ? Buffer.from(JSON.stringify(corpo)) : null;
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: metodo,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(buf ? { 'Content-Length': buf.length } : {})
      }
    }, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        let body = null;
        try { body = data ? JSON.parse(data) : null; } catch (e) { body = data; }
        resolve({ status: r.statusCode, body });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('supabase: tempo esgotado')));
    if (buf) req.write(buf);
    req.end();
  });
}
async function supabaseGet(chave) {
  const r = await supabaseReq('GET', `/rest/v1/${TABELA}?chave=eq.${encodeURIComponent(chave)}&select=valor&limit=1`);
  // banco fora do ar ou chave errada NÃO é "não existe": devolver vazio aqui
  // faria o app achar que não há contas e liberar o cadastro de administrador.
  if (r.status >= 300) {
    console.error('[store] erro ao ler', chave, r.status, JSON.stringify(r.body).slice(0, 200));
    throw new DadoIlegivel(chave, 'Supabase respondeu ' + r.status);
  }
  return (r.body && r.body[0]) ? r.body[0].valor : null;   // 200 sem linha = realmente não existe
}
async function supabaseSet(chave, valor) {
  // upsert manual (funciona mesmo sem constraint única declarada)
  const existe = await supabaseReq('GET', `/rest/v1/${TABELA}?chave=eq.${encodeURIComponent(chave)}&select=chave&limit=1`);
  if (existe.status >= 300) {
    console.error('[store] erro ao gravar', chave, existe.status, JSON.stringify(existe.body).slice(0, 200));
    throw new Error('não consegui gravar "' + chave + '": Supabase respondeu ' + existe.status);
  }
  const linha = { valor, atualizado_em: new Date().toISOString() };
  const r = (existe.body && existe.body[0])
    ? await supabaseReq('PATCH', `/rest/v1/${TABELA}?chave=eq.${encodeURIComponent(chave)}`, linha)
    : await supabaseReq('POST', `/rest/v1/${TABELA}`, { chave, ...linha });
  // gravação que falha em silêncio é dado perdido sem ninguém saber
  if (r.status >= 300) {
    console.error('[store] erro ao gravar', chave, r.status, JSON.stringify(r.body).slice(0, 200));
    throw new Error('não consegui gravar "' + chave + '": Supabase respondeu ' + r.status);
  }
}
async function supabaseDel(chave) {
  await supabaseReq('DELETE', `/rest/v1/${TABELA}?chave=eq.${encodeURIComponent(chave)}`);
}

// ─── interface usada pelo servidor ────────────────────────────────────────────
async function get(chave) {
  if (memoria.has(chave)) return memoria.get(chave);
  const v = usandoSupabase ? await supabaseGet(chave) : await arquivoGet(chave);
  if (v !== null && v !== undefined) memoria.set(chave, v);
  return v === undefined ? null : v;
}
async function set(chave, valor) {
  const anterior = memoria.get(chave);
  memoria.set(chave, valor);
  try {
    if (usandoSupabase) await naFila(chave, () => supabaseSet(chave, valor));
    else await arquivoSet(chave, valor);
  } catch (e) {
    // não deixa a memória mentir: se não gravou, o cache volta ao que era
    if (anterior === undefined) memoria.delete(chave); else memoria.set(chave, anterior);
    throw e;
  }
}
async function del(chave) {
  memoria.delete(chave);
  if (usandoSupabase) await supabaseDel(chave);
  else await arquivoDel(chave);
}

module.exports = { get, set, del, usandoSupabase, DATA_DIR, DadoIlegivel, problemaConfig, TABELA };
