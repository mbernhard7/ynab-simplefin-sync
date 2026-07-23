FROM node:22-slim

WORKDIR /app
COPY package.json server.js ./
COPY public ./public

ENV PORT=8080
EXPOSE 8080
USER node

CMD ["node", "server.js"]
