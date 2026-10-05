FROM node:24.13.0-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/opt/pnpm
ENV PATH=/opt/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

WORKDIR /opt/work-assistant
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.check.json vitest.config.ts ./
COPY packages ./packages
COPY scripts ./scripts
COPY patches ./patches
RUN pnpm install --frozen-lockfile && pnpm run build

RUN useradd --create-home --uid 10001 assistant
COPY deployment/entrypoint.sh /usr/local/bin/work-assistant-entrypoint
RUN chmod 0755 /usr/local/bin/work-assistant-entrypoint \
  && mkdir -p /data/dsh-home /workspace \
  && chown -R assistant:assistant /data /workspace /opt/work-assistant

USER assistant
ENV DSH_HOME=/data/dsh-home
ENV WA_PROFILE=personal-assistant
ENV WA_WORKSPACE=/workspace
ENV WA_MEMORY_ROOT=/workspace/memory
ENV WA_OWNER_ID=personal
ENV WA_SCHEDULE_ENABLED=false
EXPOSE 3080
ENTRYPOINT ["/usr/local/bin/work-assistant-entrypoint"]
