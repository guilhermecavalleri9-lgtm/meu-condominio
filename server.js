// ═══════════════════════════════════════════════════════════════════════════════
// PORTARIA — servidor do app de encomendas do condomínio
// ═══════════════════════════════════════════════════════════════════════════════
// App independente: sobe sozinho com `node server.js` e não depende de nenhum
// outro sistema. Node puro, sem bibliotecas externas.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./lib/store');
const whats = require('./lib/whatsapp');
const auth  = require('./lib/auth');

const PORT = process.env.PORT || 3010;
// Código exigido para criar a PRIMEIRA conta (a de administrador). Protege quem
// deixa o app aberto na internet: sem ele, quem chegasse primeiro virava admin.
const CODIGO_ADMIN = String(process.env.PORTARIA_CODIGO_ADMIN || '').trim();
// Cada pessoa da portaria tem a sua conta. Quem se cadastra fica pendente até um
// administrador aprovar; o primeiro cadastro do sistema nasce administrador.

const PUBLIC_DIR = path.join(__dirname, 'public');
const LIMITE_CORPO = 12 * 1024 * 1024; // 12 MB — foto da entrega cabe folgado

// ─── HELPERS HTTP ─────────────────────────────────────────────────────────────
function json(res, code, dados) {
  const corpo = Buffer.from(JSON.stringify(dados));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': corpo.length });
  res.end(corpo);
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let bruto = '', tamanho = 0;
    req.on('data', c => {
      tamanho += c.length;
      if (tamanho > LIMITE_CORPO) { req.destroy(); return reject(new Error('corpo grande demais')); }
      bruto += c;
    });
    req.on('end', () => { try { resolve(JSON.parse(bruto || '{}')); } catch (e) { resolve({}); } });
    req.on('error', reject);
  });
}

const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

function servirArquivo(res, arquivo, cache) {
  fs.readFile(arquivo, (err, dados) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': TIPOS[path.extname(arquivo).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': cache || 'no-cache'
    });
    res.end(dados);
  });
}

function novoId(prefixo) {
  return prefixo + '_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}
function txt(v, max) {
  return String(v === undefined || v === null ? '' : v).trim().slice(0, max || 120);
}

// ─── CONTAS ───────────────────────────────────────────────────────────────────
// O segredo que assina os tokens fica guardado junto dos dados: assim reiniciar
// o servidor não desloga todo mundo. Dá para fixar em PORTARIA_SECRET.
let _segredo = null;
async function segredo() {
  if (_segredo) return _segredo;
  if (process.env.PORTARIA_SECRET) { _segredo = String(process.env.PORTARIA_SECRET); return _segredo; }
  const guardado = await store.get('segredo');
  if (guardado && guardado.valor) { _segredo = guardado.valor; return _segredo; }
  _segredo = crypto.randomBytes(32).toString('hex');
  await store.set('segredo', { valor: _segredo, criadoEm: Date.now() });
  return _segredo;
}

const lerUsuarios = async () => {
  const d = await store.get('usuarios');
  return (d && Array.isArray(d.usuarios)) ? d.usuarios : [];
};
const gravarUsuarios = lista => store.set('usuarios', { usuarios: lista, atualizadoEm: new Date().toISOString() });

function ipDoPedido(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || (req.socket && req.socket.remoteAddress) || '';
}

// quem está pedindo? token no cabeçalho (chamadas do app) ou na URL (imagens no <img>)
async function quemEstaLogado(req, query) {
  const cabecalho = String(req.headers['authorization'] || '');
  const token = cabecalho.indexOf('Bearer ') === 0 ? cabecalho.slice(7)
              : String(req.headers['x-portaria-token'] || (query && query.get('t')) || '');
  if (!token) return null;
  const dados = auth.lerToken(token, await segredo());
  if (!dados) return null;
  const usuario = (await lerUsuarios()).find(u => u.id === dados.id);
  if (!usuario || usuario.status !== 'aprovado') return null;
  return usuario;
}

// ─── MENSAGENS PADRÃO ─────────────────────────────────────────────────────────
// Editáveis pelo app (aba Ajustes). Trechos entre chaves são trocados na hora:
// {nome} {condominio} {bloco} {apto} {codigo} {codigos} {lista} {qtd}
// {recebedor} {porteiro} {data} {hora}
const MSG_PADRAO = {
  chegadaUm:     'Olá {nome}! 👋\n\nSua entrega do código *{codigo}* chegou na portaria.\n\n📍 {bloco} · Apto {apto}\n🕒 {data} às {hora}\n\nJá pode retirar. 🙂',
  chegadaVarios: 'Olá {nome}! 👋\n\nChegaram *{qtd} entregas* pra você na portaria:\n\n{lista}\n\n📍 {bloco} · Apto {apto}\n🕒 {data} às {hora}\n\nJá pode retirar. 🙂',
  entregue:      'Olá {nome}! ✅\n\nEncomenda(s) *{codigos}* entregue(s) para *{recebedor}* em {data} às {hora}.\n\nQualquer dúvida, fale com a portaria. 🙂'
};

const fmtData = ts => new Date(ts).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const fmtHora = ts => new Date(ts).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

function montar(modelo, ctx) {
  return String(modelo || '').replace(/\{(\w+)\}/g, (todo, chave) =>
    (ctx[chave] === undefined || ctx[chave] === null) ? todo : String(ctx[chave]));
}

function contexto(cadastro, morador, bloco, apto, pacotes, extra) {
  const codigos = pacotes.map(p => p.codigo);
  const agora = Date.now();
  return Object.assign({
    nome: (morador && morador.nome) || 'morador',
    condominio: (cadastro && cadastro.condominio) || 'condomínio',
    bloco: bloco || '', apto: apto || '',
    codigo: codigos[0] || '',
    codigos: codigos.join(', '),
    lista: codigos.map((c, i) => `${i + 1}. *${c}*`).join('\n'),
    qtd: codigos.length,
    data: fmtData(agora), hora: fmtHora(agora)
  }, extra || {});
}

// aviso de chegada: um código só ou todos eles numa mensagem só
function textoChegada(cadastro, morador, bloco, apto, pacotes) {
  const msgs = Object.assign({}, MSG_PADRAO, (cadastro && cadastro.mensagens) || {});
  const modelo = pacotes.length > 1 ? msgs.chegadaVarios : msgs.chegadaUm;
  return montar(modelo, contexto(cadastro, morador, bloco, apto, pacotes));
}
function textoEntrega(cadastro, morador, bloco, apto, pacotes, recebedor, porteiro) {
  const msgs = Object.assign({}, MSG_PADRAO, (cadastro && cadastro.mensagens) || {});
  return montar(msgs.entregue, contexto(cadastro, morador, bloco, apto, pacotes, {
    recebedor: recebedor || (morador && morador.nome) || 'morador',
    porteiro: porteiro || 'portaria'
  }));
}

// ─── CADASTRO ─────────────────────────────────────────────────────────────────
// Limpa o que vem do app: campo estranho fora, texto no tamanho certo,
// telefone só com dígitos.
function sanearCadastro(body) {
  body = body || {};
  const msgs = body.mensagens || {};
  return {
    condominio: txt(body.condominio, 80) || 'Meu Condomínio',
    mensagens: {
      chegadaUm:     txt(msgs.chegadaUm, 1200)     || MSG_PADRAO.chegadaUm,
      chegadaVarios: txt(msgs.chegadaVarios, 1200) || MSG_PADRAO.chegadaVarios,
      entregue:      txt(msgs.entregue, 1200)      || MSG_PADRAO.entregue
    },
    avisoAutomatico: body.avisoAutomatico !== false,
    avisarNaEntrega: body.avisarNaEntrega !== false,
    blocos: (Array.isArray(body.blocos) ? body.blocos.slice(0, 200) : []).map(b => ({
      id: txt(b.id, 40) || novoId('b'),
      nome: txt(b.nome, 40) || 'Bloco',
      apartamentos: (Array.isArray(b.apartamentos) ? b.apartamentos.slice(0, 600) : []).map(a => ({
        id: txt(a.id, 40) || novoId('a'),
        numero: txt(a.numero, 20) || '?',
        moradores: (Array.isArray(a.moradores) ? a.moradores.slice(0, 20) : []).map(m => ({
          id: txt(m.id, 40) || novoId('m'),
          nome: txt(m.nome, 60) || 'Morador',
          telefone: whats.normalizarTelefone(m.telefone),
          avisar: m.avisar !== false
        }))
      }))
    })),
    atualizadoEm: new Date().toISOString()
  };
}

function acharLocal(cadastro, blocoId, aptoId) {
  const bloco = ((cadastro && cadastro.blocos) || []).find(b => b.id === blocoId) || null;
  const apto = bloco ? ((bloco.apartamentos || []).find(a => a.id === aptoId) || null) : null;
  return { bloco, apto };
}

// ─── PACOTES ──────────────────────────────────────────────────────────────────
const DIAS_HISTORICO = 120;  // entregas mais antigas saem da lista
const MAX_PACOTES = 4000;

const lerCadastro = async () => (await store.get('cadastro')) || sanearCadastro({});
const lerPacotes = async () => {
  const d = await store.get('pacotes');
  return (d && Array.isArray(d.pacotes)) ? d.pacotes : [];
};
const gravarPacotes = lista => store.set('pacotes', { pacotes: lista, atualizadoEm: new Date().toISOString() });

// tira do histórico o que já passou do prazo (e apaga as fotos junto)
function limpar(lista) {
  const limite = Date.now() - DIAS_HISTORICO * 86400000;
  const ficam = [], saem = [];
  for (const p of lista) {
    const velho = p.status === 'entregue' && (p.entregueEm || p.criadoEm || 0) < limite;
    (velho ? saem : ficam).push(p);
  }
  ficam.sort((a, b) => (b.criadoEm || 0) - (a.criadoEm || 0));
  while (ficam.length > MAX_PACOTES) {
    const i = ficam.map(p => p.status).lastIndexOf('entregue');
    if (i < 0) break;
    saem.push(ficam.splice(i, 1)[0]);
  }
  for (const p of saem) {
    if (p.fotoId) store.del('img:' + p.fotoId);
    if (p.assinaturaId) store.del('img:' + p.assinaturaId);
  }
  return ficam;
}

// grava foto/assinatura em chave separada — a lista de encomendas continua leve
async function guardarImagem(dataUrl, prefixo, limite) {
  if (typeof dataUrl !== 'string' || dataUrl.indexOf('data:image/') !== 0) return null;
  const id = novoId(prefixo);
  await store.set('img:' + id, { dataUrl: dataUrl.slice(0, limite), criadoEm: Date.now() });
  return id;
}

// manda o aviso pra todos os moradores do apartamento que pedem para ser avisados
async function avisarMoradores(apto, montarTexto) {
  const moradores = ((apto && apto.moradores) || []).filter(m => m.avisar !== false && m.telefone);
  const enviados = [];
  for (const m of moradores) {
    const texto = montarTexto(m);
    const r = whats.automatico() ? await whats.enviar(m.telefone, texto) : { ok: false, erro: 'envio manual' };
    enviados.push({
      moradorId: m.id, morador: m.nome, telefone: m.telefone,
      enviado: r.ok, erro: r.ok ? null : r.erro,
      link: r.ok ? null : whats.link(m.telefone, texto), texto
    });
  }
  return enviados;
}

// ─── API ──────────────────────────────────────────────────────────────────────
// rotas que funcionam sem estar logado
const ABERTAS = new Set(['/api/sessao', '/api/auth/registrar', '/api/auth/entrar']);
// rotas só do administrador
const SO_ADMIN = new Set(['/api/usuarios', '/api/usuarios/aprovar', '/api/usuarios/recusar',
                          '/api/usuarios/papel', '/api/usuarios/remover']);

async function api(req, res, pathname, query) {
  const usuarios = await lerUsuarios();

  // ── porta de entrada: só passa quem está logado e aprovado ──
  let eu = null;
  if (!ABERTAS.has(pathname)) {
    eu = await quemEstaLogado(req, query);
    if (!eu) return json(res, 401, { error: 'Faça login para continuar' });
    if (SO_ADMIN.has(pathname) && eu.papel !== 'admin')
      return json(res, 403, { error: 'Só o administrador pode fazer isso' });
  }

  // ── o app pergunta como está o sistema antes de mostrar a tela ──
  if (req.method === 'GET' && pathname === '/api/sessao') {
    const logado = await quemEstaLogado(req, query);
    return json(res, 200, {
      logado: auth.usuarioPublico(logado),
      // sem ninguém cadastrado, o primeiro cadastro vira o administrador
      primeiroAcesso: usuarios.length === 0,
      exigeCodigoAdmin: usuarios.length === 0 && !!CODIGO_ADMIN,
      armazenamento: store.usandoSupabase ? 'supabase' : 'arquivo',
      // diagnóstico: diz se cada variável chegou no processo (nunca o valor delas),
      // pra não ficar no chute quando o Supabase não liga
      configSupabase: store.usandoSupabase ? null : {
        problema: store.problemaConfig,
        url: !!process.env.SUPABASE_URL,
        key: !!process.env.SUPABASE_KEY,
        urlTamanho: (process.env.SUPABASE_URL || '').trim().length,
        keyTamanho: (process.env.SUPABASE_KEY || '').trim().length,
        variaveisParecidas: Object.keys(process.env).filter(function (n) {
          return /supa|SUPA/.test(n) && n !== 'SUPABASE_URL' && n !== 'SUPABASE_KEY';
        })
      },
      envioAutomatico: whats.automatico(),
      provedor: whats.automatico() ? whats.provedor : null
    });
  }

  // ── criar conta (fica pendente até o administrador aprovar) ──
  if (req.method === 'POST' && pathname === '/api/auth/registrar') {
    const body = await lerCorpo(req);
    const usuario = auth.normalizarUsuario(body.usuario);
    const nome = txt(body.nome, 60);
    const senha = String(body.senha || '');
    if (!auth.usuarioValido(usuario))
      return json(res, 400, { error: 'Usuário: 3 a 24 letras, números, ponto, hífen ou _' });
    if (!nome) return json(res, 400, { error: 'Informe o seu nome' });
    if (senha.length < auth.MIN_SENHA)
      return json(res, 400, { error: `A senha precisa de pelo menos ${auth.MIN_SENHA} caracteres` });
    if (usuarios.some(u => u.usuario === usuario))
      return json(res, 409, { error: 'Esse usuário já existe' });

    const primeiro = usuarios.length === 0;
    if (primeiro && CODIGO_ADMIN && String(body.codigo || '').trim() !== CODIGO_ADMIN)
      return json(res, 403, { error: 'Código de administrador incorreto', precisaCodigo: true });
    const novo = {
      id: novoId('u'), usuario, nome,
      senha: auth.hashSenha(senha),
      papel: primeiro ? 'admin' : 'porteiro',
      status: primeiro ? 'aprovado' : 'pendente',
      criadoEm: Date.now(),
      aprovadoEm: primeiro ? Date.now() : null,
      aprovadoPor: primeiro ? 'sistema' : null,
      ultimoAcesso: null,
      prefs: {}
    };
    usuarios.push(novo);
    await gravarUsuarios(usuarios);
    console.log(`[contas] cadastro de "${usuario}" (${novo.status})`);
    return json(res, 200, {
      ok: true, primeiro,
      status: novo.status,
      token: primeiro ? auth.criarToken(novo, await segredo()) : null,
      usuario: auth.usuarioPublico(novo),
      mensagem: primeiro
        ? 'Conta criada como administrador. Bem-vindo!'
        : 'Cadastro enviado. Um administrador precisa aprovar antes do primeiro acesso.'
    });
  }

  // ── entrar ──
  if (req.method === 'POST' && pathname === '/api/auth/entrar') {
    const body = await lerCorpo(req);
    const usuario = auth.normalizarUsuario(body.usuario);
    const senha = String(body.senha || '');
    const ip = ipDoPedido(req);

    const travado = auth.travadoAte(usuario, ip);
    if (travado) {
      const min = Math.ceil((travado - Date.now()) / 60000);
      return json(res, 429, { error: `Muitas tentativas. Tente de novo em ${min} minuto(s).` });
    }

    const u = usuarios.find(x => x.usuario === usuario);
    // resposta igual pra usuário inexistente e senha errada: não entrega quem existe
    if (!u || !auth.senhaConfere(senha, u.senha)) {
      auth.registrarErro(usuario, ip);
      return json(res, 401, { error: 'Usuário ou senha incorretos' });
    }
    auth.limparErros(usuario, ip);
    if (u.status === 'pendente')
      return json(res, 403, { error: 'Seu cadastro ainda está esperando a aprovação do administrador.', pendente: true });
    if (u.status !== 'aprovado')
      return json(res, 403, { error: 'Este acesso foi recusado. Fale com o administrador.' });

    u.ultimoAcesso = Date.now();
    await gravarUsuarios(usuarios);
    console.log(`[contas] "${usuario}" entrou`);
    return json(res, 200, { ok: true, token: auth.criarToken(u, await segredo()), usuario: auth.usuarioPublico(u) });
  }

  // ── minha conta ──
  if (req.method === 'GET' && pathname === '/api/auth/eu') {
    return json(res, 200, { usuario: auth.usuarioPublico(eu) });
  }

  // ── preferências da conta (tema etc.) — seguem a pessoa em qualquer navegador ──
  if (req.method === 'POST' && pathname === '/api/auth/prefs') {
    const body = await lerCorpo(req);
    const u = usuarios.find(x => x.id === eu.id);
    u.prefs = Object.assign({}, u.prefs, {
      tema: body.tema === 'claro' ? 'claro' : (body.tema === 'escuro' ? 'escuro' : (u.prefs || {}).tema)
    });
    await gravarUsuarios(usuarios);
    return json(res, 200, { ok: true, prefs: u.prefs });
  }

  // ── trocar a própria senha ──
  if (req.method === 'POST' && pathname === '/api/auth/senha') {
    const body = await lerCorpo(req);
    const u = usuarios.find(x => x.id === eu.id);
    if (!auth.senhaConfere(String(body.atual || ''), u.senha))
      return json(res, 401, { error: 'Senha atual incorreta' });
    const nova = String(body.nova || '');
    if (nova.length < auth.MIN_SENHA)
      return json(res, 400, { error: `A senha nova precisa de pelo menos ${auth.MIN_SENHA} caracteres` });
    u.senha = auth.hashSenha(nova);
    await gravarUsuarios(usuarios);
    console.log(`[contas] "${u.usuario}" trocou a senha`);
    return json(res, 200, { ok: true });
  }

  // ── administrador: lista de contas ──
  if (req.method === 'GET' && pathname === '/api/usuarios') {
    return json(res, 200, { usuarios: usuarios.map(auth.usuarioPublico) });
  }

  // ── administrador: aprovar, recusar, mudar papel, remover ──
  if (req.method === 'POST' && (pathname === '/api/usuarios/aprovar' || pathname === '/api/usuarios/recusar')) {
    const body = await lerCorpo(req);
    const alvo = usuarios.find(x => x.id === txt(body.id, 40));
    if (!alvo) return json(res, 404, { error: 'Conta não encontrada' });
    const aprovar = pathname.endsWith('aprovar');
    alvo.status = aprovar ? 'aprovado' : 'recusado';
    alvo.aprovadoEm = aprovar ? Date.now() : null;
    alvo.aprovadoPor = aprovar ? eu.usuario : null;
    await gravarUsuarios(usuarios);
    console.log(`[contas] "${alvo.usuario}" ${aprovar ? 'aprovado' : 'recusado'} por "${eu.usuario}"`);
    return json(res, 200, { ok: true, usuario: auth.usuarioPublico(alvo) });
  }

  if (req.method === 'POST' && pathname === '/api/usuarios/papel') {
    const body = await lerCorpo(req);
    const alvo = usuarios.find(x => x.id === txt(body.id, 40));
    if (!alvo) return json(res, 404, { error: 'Conta não encontrada' });
    const papel = body.papel === 'admin' ? 'admin' : 'porteiro';
    // não deixa o sistema ficar sem nenhum administrador
    if (alvo.papel === 'admin' && papel !== 'admin' &&
        usuarios.filter(x => x.papel === 'admin' && x.status === 'aprovado').length <= 1)
      return json(res, 400, { error: 'Precisa sobrar pelo menos um administrador' });
    alvo.papel = papel;
    await gravarUsuarios(usuarios);
    return json(res, 200, { ok: true, usuario: auth.usuarioPublico(alvo) });
  }

  if (req.method === 'POST' && pathname === '/api/usuarios/remover') {
    const body = await lerCorpo(req);
    const id = txt(body.id, 40);
    const alvo = usuarios.find(x => x.id === id);
    if (!alvo) return json(res, 404, { error: 'Conta não encontrada' });
    if (alvo.id === eu.id) return json(res, 400, { error: 'Você não pode excluir a sua própria conta' });
    if (alvo.papel === 'admin' &&
        usuarios.filter(x => x.papel === 'admin' && x.status === 'aprovado').length <= 1)
      return json(res, 400, { error: 'Precisa sobrar pelo menos um administrador' });
    await gravarUsuarios(usuarios.filter(x => x.id !== id));
    console.log(`[contas] "${alvo.usuario}" removido por "${eu.usuario}"`);
    return json(res, 200, { ok: true });
  }

  // ── carrega tudo que o app precisa pra abrir ──
  if (req.method === 'GET' && pathname === '/api/dados') {
    const [cadastro, pacotes] = await Promise.all([lerCadastro(), lerPacotes()]);
    return json(res, 200, {
      cadastro, pacotes,
      envioAutomatico: whats.automatico(),
      provedor: whats.automatico() ? whats.provedor : null,
      msgPadrao: MSG_PADRAO
    });
  }

  // ── salva o cadastro (blocos, apartamentos, moradores, mensagens) ──
  if (req.method === 'POST' && pathname === '/api/cadastro') {
    const body = await lerCorpo(req);
    const cadastro = sanearCadastro(body);
    await store.set('cadastro', cadastro);
    return json(res, 200, { ok: true, cadastro });
  }

  // ── bipagem: registra um ou vários códigos no apartamento escolhido ──
  if (req.method === 'POST' && pathname === '/api/pacotes/registrar') {
    const body = await lerCorpo(req);
    const blocoId = txt(body.blocoId, 40), aptoId = txt(body.aptoId, 40);
    const codigos = (Array.isArray(body.codigos) ? body.codigos : [body.codigo])
      .map(c => txt(c, 60).toUpperCase()).filter(Boolean).slice(0, 50);
    if (!codigos.length) return json(res, 400, { error: 'informe pelo menos um código' });

    const cadastro = await lerCadastro();
    const { bloco, apto } = acharLocal(cadastro, blocoId, aptoId);
    if (!bloco || !apto) return json(res, 404, { error: 'bloco ou apartamento não encontrado' });

    const lista = await lerPacotes();
    const agora = Date.now();
    const criados = [], repetidos = [];
    for (const codigo of codigos) {
      // já pendente = o porteiro bipou duas vezes; não duplica
      const igual = lista.find(p => p.codigo === codigo && p.status === 'pendente');
      if (igual) { repetidos.push(igual); continue; }
      const p = {
        id: novoId('p'), codigo, blocoId, aptoId,
        bloco: bloco.nome, apto: apto.numero,
        status: 'pendente', criadoEm: agora,
        porteiro: eu.nome,
        avisadoEm: null, entregueEm: null, recebidoPor: '',
        fotoId: null, assinaturaId: null, obs: ''
      };
      lista.push(p); criados.push(p);
    }
    await gravarPacotes(limpar(lista));
    if (criados.length) console.log(`[portaria] ${criados.length} encomenda(s) · ${bloco.nome} apto ${apto.numero}`);
    return json(res, 200, { ok: true, criados, repetidos });
  }

  // ── avisa a chegada no WhatsApp (uma mensagem com todos os códigos) ──
  if (req.method === 'POST' && pathname === '/api/avisar') {
    const body = await lerCorpo(req);
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(i => txt(i, 40)).filter(Boolean);
    const cadastro = await lerCadastro();
    const lista = await lerPacotes();
    const alvo = lista.filter(p => ids.indexOf(p.id) !== -1);
    if (!alvo.length) return json(res, 400, { error: 'nenhuma encomenda selecionada' });

    const { bloco, apto } = acharLocal(cadastro, alvo[0].blocoId, alvo[0].aptoId);
    if (!apto) return json(res, 404, { error: 'apartamento não encontrado' });

    const enviados = await avisarMoradores(apto, m =>
      textoChegada(cadastro, m, bloco && bloco.nome, apto.numero, alvo));
    if (enviados.some(e => e.enviado)) {
      const agora = Date.now();
      for (const p of alvo) p.avisadoEm = agora;
      await gravarPacotes(lista);
    }
    return json(res, 200, {
      ok: true, enviados, automatico: whats.automatico(),
      semTelefone: enviados.length === 0
    });
  }

  // ── o app abriu os links wa.me: marca as encomendas como avisadas ──
  if (req.method === 'POST' && pathname === '/api/avisado') {
    const body = await lerCorpo(req);
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(i => txt(i, 40));
    const lista = await lerPacotes();
    const agora = Date.now();
    let n = 0;
    for (const p of lista) if (ids.indexOf(p.id) !== -1 && !p.avisadoEm) { p.avisadoEm = agora; n++; }
    if (n) await gravarPacotes(lista);
    return json(res, 200, { ok: true, marcados: n });
  }

  // ── entrega ao morador: quem recebeu + foto + assinatura ──
  if (req.method === 'POST' && pathname === '/api/pacotes/entregar') {
    const body = await lerCorpo(req);
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(i => txt(i, 40)).filter(Boolean);
    if (!ids.length) return json(res, 400, { error: 'nenhuma encomenda selecionada' });

    const lista = await lerPacotes();
    const alvo = lista.filter(p => ids.indexOf(p.id) !== -1 && p.status === 'pendente');
    if (!alvo.length) return json(res, 400, { error: 'encomendas já entregues ou inexistentes' });

    const fotoId = await guardarImagem(body.foto, 'f', 4000000);
    const assinaturaId = await guardarImagem(body.assinatura, 's', 2000000);

    const agora = Date.now();
    const recebedor = txt(body.recebidoPor, 60) || 'morador';
    for (const p of alvo) {
      p.status = 'entregue'; p.entregueEm = agora;
      p.recebidoPor = recebedor;
      p.recebedorId = txt(body.moradorId, 40);
      p.porteiroEntrega = eu.nome;
      p.obs = txt(body.obs, 300);
      p.fotoId = fotoId; p.assinaturaId = assinaturaId;
    }
    await gravarPacotes(limpar(lista));

    let enviados = [];
    if (body.avisar) {
      const cadastro = await lerCadastro();
      const { bloco, apto } = acharLocal(cadastro, alvo[0].blocoId, alvo[0].aptoId);
      enviados = await avisarMoradores(apto, m =>
        textoEntrega(cadastro, m, bloco && bloco.nome, apto && apto.numero, alvo, recebedor, eu.nome));
    }
    console.log(`[portaria] ${alvo.length} encomenda(s) entregue(s) para ${recebedor}`);
    return json(res, 200, { ok: true, entregues: alvo.map(p => p.id), enviados, automatico: whats.automatico() });
  }

  // ── apagar encomenda registrada por engano ──
  if (req.method === 'POST' && pathname === '/api/pacotes/remover') {
    const body = await lerCorpo(req);
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(i => txt(i, 40));
    const lista = await lerPacotes();
    const ficam = [];
    let n = 0;
    for (const p of lista) {
      if (ids.indexOf(p.id) !== -1) {
        n++;
        if (p.fotoId) store.del('img:' + p.fotoId);
        if (p.assinaturaId) store.del('img:' + p.assinaturaId);
      } else ficam.push(p);
    }
    if (n) await gravarPacotes(ficam);
    return json(res, 200, { ok: true, removidos: n });
  }

  // ── foto ou assinatura de uma entrega (abre direto no <img src>) ──
  if (req.method === 'GET' && pathname === '/api/imagem') {
    const id = txt(query.get('id'), 40);
    const img = id ? await store.get('img:' + id) : null;
    const m = img && img.dataUrl ? /^data:([\w/+.-]+);base64,(.*)$/.exec(img.dataUrl) : null;
    if (!m) { res.writeHead(404); return res.end('Not found'); }
    const bin = Buffer.from(m[2], 'base64');
    res.writeHead(200, { 'Content-Type': m[1], 'Content-Length': bin.length, 'Cache-Control': 'private, max-age=86400' });
    return res.end(bin);
  }

  return json(res, 404, { error: 'rota não encontrada' });
}

// ─── SERVIDOR ─────────────────────────────────────────────────────────────────
async function atender(req, res) {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = decodeURIComponent(u.pathname);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Portaria-Pin',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    return res.end();
  }

  try {
    if (pathname.indexOf('/api/') === 0) return await api(req, res, pathname, u.searchParams);
  } catch (e) {
    console.error('[erro]', pathname, e.message);
    // dado ilegível nunca pode ser confundido com "ainda não existe": sem isso,
    // um arquivo corrompido zeraria a lista de contas e abriria o cadastro de admin
    if (e.name === 'DadoIlegivel')
      return json(res, 503, { error: 'Os dados do sistema não puderam ser lidos. Nada foi apagado — restaure a cópia de segurança antes de continuar.' });
    // detalhe do erro só no log do servidor: a mensagem crua já chegou a expor
    // o valor de uma variável de ambiente na resposta pública
    return json(res, 500, { error: 'Erro no servidor. Veja os logs para o detalhe.' });
  }

  // arquivos do app
  if (req.method === 'GET') {
    if (pathname === '/' || pathname === '/index.html') return servirArquivo(res, path.join(PUBLIC_DIR, 'index.html'));
    if (pathname === '/sw.js') {
      res.writeHead(200, { 'Content-Type': TIPOS['.js'], 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' });
      return fs.createReadStream(path.join(PUBLIC_DIR, 'sw.js')).pipe(res);
    }
    // nada de subir pastas com ../
    const seguro = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    const arquivo = path.join(PUBLIC_DIR, seguro);
    if (arquivo.indexOf(PUBLIC_DIR) === 0 && fs.existsSync(arquivo) && fs.statSync(arquivo).isFile()) {
      return servirArquivo(res, arquivo, /\.(png|svg|ico)$/.test(arquivo) ? 'public, max-age=86400' : 'no-cache');
    }
  }

  res.writeHead(404); res.end('Not found');
}

// ─── HTTPS ────────────────────────────────────────────────────────────────────
// Com TLS_CERT e TLS_KEY o próprio servidor fala https (certificado próprio ou
// Let's Encrypt). Atrás de um proxy que já cuida do TLS (Cloudflare, Render,
// nginx), deixe sem: o proxy entrega https pro celular e conversa em http aqui.
const TLS_CERT = process.env.TLS_CERT || '';
const TLS_KEY  = process.env.TLS_KEY  || '';
const usandoTLS = !!(TLS_CERT && TLS_KEY);

const server = usandoTLS
  ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, atender)
  : http.createServer(atender);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🏢 Meu Condomínio na porta ${PORT} (${usandoTLS ? 'https' : 'http'})`);
  console.log(`   dados: ${store.usandoSupabase ? 'Supabase (tabela ' + store.TABELA + ')' : store.DATA_DIR}`);
  if (store.problemaConfig) console.log('   ⛔ ' + store.problemaConfig);
  if (!store.usandoSupabase)
    console.log('   ⚠ os dados ficam em disco: em hospedagem que dorme ou reinicia (Render free e afins)\n' +
                '     isso é apagado a cada restart. Configure SUPABASE_URL e SUPABASE_KEY.');
  console.log(`   whatsapp: ${whats.automatico() ? 'automático (' + whats.provedor + ')' : 'manual (link wa.me)'}`);
  if (!usandoTLS) console.log('   ⚠ sem https: senha e foto trafegam abertas fora de localhost — veja o README');
  lerUsuarios().then(us => {
    const admins = us.filter(u => u.papel === 'admin' && u.status === 'aprovado').length;
    const pendentes = us.filter(u => u.status === 'pendente').length;
    console.log(us.length
      ? `   contas: ${us.length} (${admins} admin, ${pendentes} esperando aprovação)`
      : '   contas: nenhuma ainda — o primeiro cadastro vira o administrador');
  }).catch(() => {});
});
