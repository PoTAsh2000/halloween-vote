FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/halloween.db

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

RUN chmod -R a+rX /app && mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
