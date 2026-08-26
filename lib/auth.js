// ═══════════════════════════════════════════════════════════════════════════════
// CONTAS — cadastro, login e aprovação pelo administrador
// ═══════════════════════════════════════════════════════════════════════════════
// Como funciona:
//   • quem se cadastra nasce PENDENTE e não entra até um administrador aprovar;
//   • o primeiro cadastro do sistema nasce administrador e já aprovado, senão
//     não existiria ninguém para aprovar os outros;
//   • a senha nunca é guardada — só o hash scrypt com sal próprio;
//   • a sessão é um token assinado (HMAC) com validade, guardado no aparelho;
//     como as contas ficam no servidor, entrar de outro navegador traz tudo.
const crypto = require('crypto');

const DIAS_SESSAO = 30;
const MIN_SENHA = 6;
const MAX_TENTATIVAS = 5;          // erros de senha antes de travar
const TRAVA_MINUTOS = 5;

// ─── senha ────────────────────────────────────────────────────────────────────
function hashSenha(senha) {
  const sal = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(senha), sal, 32);
  return 'scrypt$' + sal.toString('hex') + '$' + hash.toString('hex');
}
function senhaConfere(senha, guardado) {
  try {
    const [alg, salHex, hashHex] = String(guardado || '').split('$');
    if (alg !== 'scrypt' || !salHex || !hashHex) return false;
    const esperado = Buffer.from(hashHex, 'hex');
    const veio = crypto.scryptSync(String(senha), Buffer.from(salHex, 'hex'), esperado.length);
    return crypto.timingSafeEqual(esperado, veio);   // comparação sem vazar tempo
  } catch (e) { return false; }
}

// ─── token de sessão ──────────────────────────────────────────────────────────
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function deB64url(txt) {
  return Buffer.from(String(txt).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function criarToken(usuario, segredo) {
  const corpo = b64url(JSON.stringify({
    id: usuario.id,
    exp: Date.now() + DIAS_SESSAO * 86400000
  }));
  const assinatura = b64url(crypto.createHmac('sha256', segredo).update(corpo).digest());
  return corpo + '.' + assinatura;
}

function lerToken(token, segredo) {
  try {
    const [corpo, assinatura] = String(token || '').split('.');
    if (!corpo || !assinatura) return null;
    const esperada = crypto.createHmac('sha256', segredo).update(corpo).digest();
    const veio = deB64url(assinatura);
    if (veio.length !== esperada.length || !crypto.timingSafeEqual(esperada, veio)) return null;
    const dados = JSON.parse(deB64url(corpo).toString('utf8'));
    if (!dados || !dados.exp || dados.exp < Date.now()) return null;
    return dados;
  } catch (e) { return null; }
}

// ─── trava de tentativas (por usuário + IP, na memória do processo) ───────────
const _tentativas = new Map();
function chaveTentativa(usuario, ip) { return String(usuario || '') + '|' + String(ip || ''); }
function travadoAte(usuario, ip) {
  const t = _tentativas.get(chaveTentativa(usuario, ip));
  return (t && t.ate > Date.now()) ? t.ate : 0;
}
function registrarErro(usuario, ip) {
  const chave = chaveTentativa(usuario, ip);
  const t = _tentativas.get(chave) || { erros: 0, ate: 0 };
  t.erros++;
  if (t.erros >= MAX_TENTATIVAS) { t.ate = Date.now() + TRAVA_MINUTOS * 60000; t.erros = 0; }
  _tentativas.set(chave, t);
  return t.ate;
}
function limparErros(usuario, ip) { _tentativas.delete(chaveTentativa(usuario, ip)); }

// ─── validações e formato ─────────────────────────────────────────────────────
function normalizarUsuario(u) {
  return String(u || '').trim().toLowerCase().replace(/\s+/g, '');
}
function usuarioValido(u) { return /^[a-z0-9._-]{3,24}$/.test(u); }

// o que pode ser devolvido pro app: nunca o hash da senha
function usuarioPublico(u) {
  if (!u) return null;
  return {
    id: u.id, usuario: u.usuario, nome: u.nome,
    papel: u.papel, status: u.status, contaPai: u.contaPai || null,
    criadoEm: u.criadoEm, aprovadoEm: u.aprovadoEm || null,
    ultimoAcesso: u.ultimoAcesso || null,
    prefs: u.prefs || {}
  };
}

module.exports = {
  DIAS_SESSAO, MIN_SENHA, TRAVA_MINUTOS,
  hashSenha, senhaConfere, criarToken, lerToken,
  travadoAte, registrarErro, limparErros,
  normalizarUsuario, usuarioValido, usuarioPublico
};
