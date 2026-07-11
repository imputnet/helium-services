FROM denoland/deno:2.8.1

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ARG SYMSORTER_VERSION=26.6.0
ARG TARGETARCH=amd64
RUN arch="x86_64"; [ "$TARGETARCH" = "arm64" ] && arch="aarch64"; \
  curl -fsSL -o /usr/local/bin/symsorter \
  "https://github.com/getsentry/symbolicator/releases/download/${SYMSORTER_VERSION}/symsorter-Linux-${arch}" \
  && chmod +x /usr/local/bin/symsorter \
  && /usr/local/bin/symsorter --version

USER deno
WORKDIR /app
COPY --chown=deno:deno deno.json deno.lock ./
COPY --chown=deno:deno src ./src
RUN deno cache --frozen src/main.ts

EXPOSE 8080
CMD ["deno", "task", "start"]
