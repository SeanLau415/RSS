FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src ./src
COPY config.example.yaml ./config.example.yaml

ENV PORT=8080
ENV HOST=0.0.0.0
ENV CONFIG_PATH=/app/data/config.yaml
ENV STATE_PATH=/app/data/state.json

EXPOSE 8080

CMD ["node", "src/server.js"]
