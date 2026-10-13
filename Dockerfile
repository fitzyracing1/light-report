FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json server.mjs ./
COPY lib/ ./lib/
COPY bin/ ./bin/
ENV HOST=0.0.0.0 PORT=8080 DATA_DIR=/data LIGHT_TTL_SECONDS=86400
EXPOSE 8080
CMD ["node", "server.mjs"]
