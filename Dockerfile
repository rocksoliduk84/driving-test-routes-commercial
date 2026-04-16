FROM node:20-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY prisma ./prisma
COPY public ./public
COPY src ./src
COPY .env.example ./.env.example
RUN npx prisma generate
EXPOSE 3000
CMD ["node", "src/server.js"]
