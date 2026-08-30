# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=26-bookworm-slim
ARG PYTHON_VERSION=3.13-slim-bookworm
ARG NGINX_VERSION=1.29-alpine
ARG PNPM_VERSION=10.18.2
ARG UV_VERSION=0.11.8

FROM node:${NODE_VERSION} AS node-base
ARG PNPM_VERSION
RUN npm install --global "pnpm@${PNPM_VERSION}"
WORKDIR /app

FROM node-base AS editor-build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/editor/package.json apps/editor/package.json
COPY apps/bridge/package.json apps/bridge/package.json
COPY packages/acp-rad/package.json packages/acp-rad/package.json
RUN pnpm install --frozen-lockfile
COPY apps/editor apps/editor
COPY packages/acp-rad packages/acp-rad
RUN pnpm --filter editor build

FROM nginx:${NGINX_VERSION} AS editor
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=editor-build /app/apps/editor/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -q -O - http://127.0.0.1:8080/healthz >/dev/null || exit 1

FROM node-base AS bridge-node-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/editor/package.json apps/editor/package.json
COPY apps/bridge/package.json apps/bridge/package.json
COPY packages/acp-rad/package.json packages/acp-rad/package.json
RUN pnpm install --frozen-lockfile --filter bridge --prod

FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv-bin

FROM python:${PYTHON_VERSION} AS agent-build
COPY --from=uv-bin /uv /uvx /bin/
WORKDIR /app
COPY agents/rad-agent/pyproject.toml agents/rad-agent/uv.lock agents/rad-agent/README.md agents/rad-agent/
COPY agents/rad-agent/src agents/rad-agent/src
RUN uv sync --project agents/rad-agent --frozen --no-dev

FROM python:${PYTHON_VERSION} AS bridge
ENV NODE_ENV=production \
    LD_LIBRARY_PATH=/usr/local/lib \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
COPY --from=node-base /usr/local/ /usr/local/
COPY --from=node-base /usr/lib/*/libatomic.so.1* /usr/local/lib/
RUN groupadd --system app && \
    useradd --system --gid app --home-dir /app app && \
    mkdir -p /app/audit && \
    chown app:app /app/audit
WORKDIR /app
COPY --from=bridge-node-deps --chown=app:app /app /app
COPY --from=agent-build --chown=app:app /app/agents/rad-agent /app/agents/rad-agent
COPY --chown=app:app apps/bridge/src apps/bridge/src
COPY --chown=app:app apps/bridge/package.json apps/bridge/package.json
COPY --chown=app:app docker/agents.json apps/bridge/agents.json
USER app
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "apps/bridge/src/index.ts"]
