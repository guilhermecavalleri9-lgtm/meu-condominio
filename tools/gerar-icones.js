// Gera os ícones do app (PNG) a partir de public/logo.svg.
//   node tools/gerar-icones.js
//
// Usa o Chromium do Playwright só para rasterizar o SVG com qualidade. É uma
// ferramenta de desenvolvimento: os PNGs já vão versionados no repositório, então
// o app roda sem isso instalado. Se precisar regerar e não tiver o Playwright:
//   npx playwright install chromium && npx playwright-core --version
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const PUBLICO = path.join(RAIZ, 'public');
const LOGO = fs.readFileSync(path.join(PUBLICO, 'logo.svg'), 'utf8');

// fundo claro arredondado, com a marca centralizada
function pagina(tamanho, escalaLogo, arredondar) {
  const raio = arredondar ? Math.round(tamanho * 0.22) : 0;
  return `<!doctype html><meta charset="utf-8">
<body style="margin:0;width:${tamanho}px;height:${tamanho}px;background:transparent">
  <div style="width:${tamanho}px;height:${tamanho}px;border-radius:${raio}px;background:#f4f6fb;
              display:flex;align-items:center;justify-content:center;overflow:hidden">
    <div style="width:${Math.round(tamanho * escalaLogo)}px">${LOGO.replace(/width="\d+" height="\d+"/, 'width="100%"')}</div>
  </div>
</body>`;
}

(async () => {
  let chromium;
  try { chromium = require('playwright').chromium; }
  catch (e) {
    try { chromium = require('playwright-core').chromium; }
    catch (e2) {
      console.error('Precisa do Playwright para regerar os ícones: npm i -D playwright');
      console.error('Os PNGs atuais continuam válidos — nada foi alterado.');
      process.exit(1);
    }
  }
  const navegador = await chromium.launch();
  const alvos = [
    { arquivo: 'icon-192.png', tamanho: 192, escala: 0.74, arredondar: true },
    { arquivo: 'icon-512.png', tamanho: 512, escala: 0.74, arredondar: true },
    { arquivo: 'icon-180.png', tamanho: 180, escala: 0.74, arredondar: true },
    // maskable: o Android recorta as bordas, então a marca fica menor e o fundo sangra
    { arquivo: 'icon-maskable-512.png', tamanho: 512, escala: 0.54, arredondar: false }
  ];
  for (const alvo of alvos) {
    const p = await navegador.newPage({ viewport: { width: alvo.tamanho, height: alvo.tamanho } });
    await p.setContent(pagina(alvo.tamanho, alvo.escala, alvo.arredondar));
    await p.waitForTimeout(120);
    await p.screenshot({ path: path.join(PUBLICO, alvo.arquivo), omitBackground: true });
    await p.close();
    console.log('gerado', alvo.arquivo);
  }
  await navegador.close();
})();
