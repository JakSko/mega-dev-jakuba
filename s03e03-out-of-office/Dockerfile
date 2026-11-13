# The agent's host image: Node, git, the pinned Codex CLI, the runner and a seed copy of the API (here: the example API).
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates util-linux \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g --no-fund --no-audit @openai/codex@0.165.0
# Model-written code (Codex, the tests it writes, git in the working copy) runs as this user,
# with none of the runner's secrets in its environment.
RUN useradd --create-home --uid 1001 coder
COPY example-api /seed/api
RUN cd /seed/api && npm ci --no-fund --no-audit
COPY runner /app/runner
COPY entrypoint.sh /app/entrypoint.sh
ENV DATA_DIR=/data RUN_UID=1001 RUN_GID=1001 RUN_HOME=/home/coder
CMD ["sh", "/app/entrypoint.sh"]
