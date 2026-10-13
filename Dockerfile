FROM node:22-bookworm-slim
# git + python + make so the runner can build common public repos
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 python3-venv python3-pip make \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json server.mjs ./
COPY lib/ ./lib/
COPY bin/ ./bin/
# server runs as root (to own the /data volume); runner jobs drop to uid 1000 ("node")
ENV HOST=0.0.0.0 PORT=8080 DATA_DIR=/data LIGHT_TTL_SECONDS=86400 \
    RUN_AS_UID=1000 RUN_AS_GID=1000 RUN_TIMEOUT_SECONDS=600 RUN_CONCURRENCY=1 RUN_MAX_QUEUE=10 \
    RUN_LOG_BYTES=1000000 RUNS_PER_IP_PER_HOUR=6
EXPOSE 8080
CMD ["node", "server.mjs"]
