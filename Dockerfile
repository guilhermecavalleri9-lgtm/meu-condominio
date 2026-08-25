# Imagem enxuta: o app não tem nenhuma dependência para instalar.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public

# a porta vem do ambiente (Render, Railway e Fly definem sozinhos)
ENV PORT=3010
EXPOSE 3010

# sem SUPABASE_URL, os dados ficam aqui dentro — e somem a cada novo deploy.
# Em hospedagem, configure o Supabase (veja o README).
ENV DATA_DIR=/dados
VOLUME ["/dados"]

CMD ["node", "server.js"]
