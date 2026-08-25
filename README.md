# 🏠 Meu Condomínio · encomendas da portaria

App para o porteiro receber e entregar encomendas, avisando o morador no WhatsApp.
Sobe sozinho com `node server.js`, sem depender de nenhum outro sistema, e usa só o Node
(nenhuma biblioteca para instalar).

## Contas e acesso

Cada pessoa da portaria tem a **sua conta** — os dados ficam todos no servidor, então
entrar de outro navegador, de outro computador ou do celular traz tudo de volta (inclusive
a preferência de tema).

- **O primeiro cadastro do sistema vira o administrador**, já liberado (senão não existiria
  ninguém para aprovar os outros).
- Os demais se cadastram normalmente, mas o acesso **fica pendente até o administrador
  aprovar**, em Ajustes → *Contas da portaria*.
- O administrador também recusa, libera de novo, promove a administrador e exclui contas.
  O sistema não deixa ficar sem nenhum administrador.
- Quem bipou e quem entregou é registrado a partir da conta logada — não dá para digitar
  outro nome.

Senhas ficam guardadas só como hash `scrypt` com sal próprio. A sessão dura 30 dias num
token assinado; recusar ou excluir uma conta derruba o acesso na hora. Cinco senhas erradas
travam aquele usuário por 5 minutos.

## Como o porteiro usa

1. **Início** — lista dos blocos cadastrados. Botão **Adicionar bloco**.
2. **Bloco** — os apartamentos daquele bloco, com a quantidade de encomendas esperando.
3. **Apartamento** — a tela de trabalho:
   - **bipar** com o leitor USB do computador (o leitor digita o código e dá Enter — é só
     manter a tela aberta), pela **câmera do celular**, ou digitando à mão;
   - o aviso no WhatsApp sai com **todos os códigos numa mensagem só**;
   - **entregar** ao morador com **foto** e **assinatura** na tela.
4. **Pendentes** — tudo que está aguardando retirada, agrupado por apartamento.
5. **Histórico** — as entregas feitas, com o comprovante (foto + assinatura).
6. **Ajustes** — sua conta, contas da portaria (só administrador), nome do condomínio e
   o texto das mensagens.

O botão no canto de cima alterna **modo claro / noturno**. Sem escolha feita, ele segue o
tema do próprio aparelho; depois de escolher, a preferência fica gravada naquele aparelho.

Cada apartamento pode ter **vários moradores, cada um com o seu WhatsApp**, e uma
chavinha por morador diz quem recebe ou não o aviso.

## Publicar com https (recomendado)

Sem `https`, o navegador **não deixa instalar o app, não libera a câmera** e a senha do
porteiro trafega aberta na rede. Em `localhost` tudo funciona; para o celular do porteiro,
escolha um destes caminhos:

**1. Túnel do Cloudflare — o mais rápido, de graça, sem abrir porta no roteador**

Rode o app normalmente (`node server.js`) e, ao lado:

```bash
cloudflared tunnel --url http://localhost:3010
```

Ele imprime um endereço `https://algo-aleatorio.trycloudflare.com` que já funciona no
celular, com certificado válido. Bom para testar hoje mesmo; o endereço muda a cada vez.
Com uma conta gratuita da Cloudflare e um domínio, o túnel ganha endereço fixo.

**2. Hospedagem com https automático (endereço fixo)**

Já vão no repositório o `Dockerfile` e o `render.yaml`. No Render: *New → Blueprint* →
aponte para este repositório. Vale o mesmo para Railway, Fly.io ou qualquer host de
container.

Nessas hospedagens o disco é apagado a cada deploy: configure `SUPABASE_URL` e
`SUPABASE_KEY` (veja *Onde ficam os dados*), senão cadastro, encomendas e contas se perdem.

**3. Certificado próprio (rede interna do condomínio)**

Com um certificado em mãos, o próprio app fala https:

```bash
TLS_CERT=/caminho/cert.pem TLS_KEY=/caminho/chave.pem node server.js
```

Para a rede local, o [mkcert](https://github.com/FiloSottile/mkcert) gera um certificado
confiável nos aparelhos onde a autoridade dele for instalada. Certificado autoassinado
comum não serve: o navegador reclama e continua sem instalar o app nem liberar a câmera.

## Instalar como app no celular

O app é um PWA. Na tela inicial aparece a faixa **Instalar na tela inicial** (e o mesmo
botão fica em Ajustes): ele ganha ícone próprio e abre em tela cheia, sem barra do
navegador. No Android o próprio Chrome instala com um toque; no iPhone o app mostra o
passo a passo do Safari (Compartilhar → Adicionar à Tela de Início), porque o iOS não
tem instalação automática.

⚠️ **Instalar exige `https`** (ou `localhost`) — assim como a câmera. Pelo IP da rede em
`http` comum, o navegador não oferece a instalação; o app avisa isso na tela em vez de
deixar você tentando à toa.

## Rodando

```bash
node server.js          # http://localhost:3010
```

Para o celular do porteiro acessar, use o IP do computador na rede
(`http://192.168.0.10:3010`). A **câmera só funciona em HTTPS ou em localhost** —
é uma trava dos navegadores. Na rede local, publique atrás de um HTTPS
(Cloudflare Tunnel, ngrok, nginx com certificado) ou use o leitor USB.

## Aviso no WhatsApp

Funciona de dois jeitos:

**1. Manual (padrão, sem configurar nada)** — o app monta a mensagem pronta e abre a
conversa do morador no WhatsApp do próprio aparelho. O porteiro só toca em enviar.
Não precisa de conta paga nem de número dedicado.

**2. Automático** — configurando um provedor, o servidor envia sozinho, sem ninguém tocar
em nada. Escolha um destes:

| Provedor | Variáveis de ambiente |
|---|---|
| [Z-API](https://z-api.io) | `WHATSAPP_PROVIDER=zapi`, `ZAPI_INSTANCE`, `ZAPI_TOKEN`, `ZAPI_CLIENT_TOKEN` |
| [Evolution API](https://github.com/EvolutionAPI/evolution-api) (auto-hospedada) | `WHATSAPP_PROVIDER=evolution`, `EVOLUTION_URL`, `EVOLUTION_KEY`, `EVOLUTION_INSTANCE` |
| WhatsApp Cloud API (oficial da Meta) | `WHATSAPP_PROVIDER=cloud`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_TEMPLATE`, `WHATSAPP_TEMPLATE_LANG` |

```bash
WHATSAPP_PROVIDER=zapi ZAPI_INSTANCE=xxx ZAPI_TOKEN=yyy node server.js
```

Na API oficial da Meta, mensagem iniciada pela empresa fora da janela de 24h só sai por
**template aprovado** — por isso o `WHATSAPP_TEMPLATE`: o texto da encomenda vai como
parâmetro do corpo do template. Z-API e Evolution mandam texto livre.

Com o envio automático ligado, o app espera ~8 segundos depois da última bipagem antes de
mandar — assim, se chegaram 3 encomendas para o mesmo apartamento, sai **uma mensagem só
com os 3 códigos**. Dá para tocar no botão para enviar antes da hora, e a espera pode ser
desligada em Ajustes.

## Mensagens

Editáveis em **Ajustes**, com três modelos: chegou 1 encomenda, chegaram várias, e
encomenda entregue. Trechos entre chaves são trocados na hora do envio:

`{nome}` `{condominio}` `{bloco}` `{apto}` `{codigo}` `{codigos}` `{lista}` `{qtd}`
`{recebedor}` `{porteiro}` `{data}` `{hora}`

Exemplo do padrão:

> Olá Maria Souza! 👋
> Sua entrega do código **BR123456789BR** chegou na portaria.
> 📍 Bloco A · Apto 101 — 🕒 24/08/2026 às 21:59

## Outras variáveis

| Variável | Para que serve |
|---|---|
| `PORT` | porta do servidor (padrão `3010`) |
| `PORTARIA_SECRET` | chave que assina as sessões; sem ela, uma é gerada e guardada junto dos dados |
| `TLS_CERT` + `TLS_KEY` | caminhos do certificado e da chave; com os dois, o app fala https direto |
| `DATA_DIR` | pasta dos dados no modo arquivo (padrão `dados/`) |
| `SUPABASE_URL` + `SUPABASE_KEY` | guarda tudo no Supabase em vez do disco |
| `SUPABASE_TABELA` | nome da tabela (padrão `portaria_kv`) |

## Onde ficam os dados

Sem Supabase, tudo vai para arquivos JSON em `dados/` (gravação atômica: escreve
num temporário e renomeia, para não corromper se faltar energia). Em hospedagem que apaga o
disco a cada deploy (Render, Railway e afins), use o Supabase criando a tabela:

As contas ficam na mesma tabela/pasta dos outros dados (chave `usuarios`).

```sql
create table portaria_kv (
  chave text primary key,
  valor jsonb not null,
  atualizado_em timestamptz default now()
);
```

Fotos e assinaturas ficam em chaves separadas das listas, então carregar a tela de
encomendas não puxa imagem nenhuma. Entregas com mais de 120 dias saem do histórico
automaticamente, junto com as suas imagens.

## Logo e ícones

A marca fica em `public/logo.svg` (telhado + M + C + encomenda). Na tela de login ela é
desenhada em SVG, então o telhado acompanha o tema claro ou escuro.

`npm run icones` regera os PNGs do app a partir desse SVG. É uma ferramenta de
desenvolvimento e usa o Chromium do Playwright só para rasterizar; os PNGs já vão
versionados, então o app roda sem isso instalado.
