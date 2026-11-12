FROM node:22-bookworm-slim
WORKDIR /app
COPY server/package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server/src ./src
COPY lib/assistant.ts lib/plan-amendment.ts ./shared/
USER node
EXPOSE 8080
CMD ["node", "--experimental-transform-types", "src/server.mjs"]
