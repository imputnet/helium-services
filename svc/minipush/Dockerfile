FROM denoland/deno:alpine-2.7.11@sha256:bfe6fc22587a359956a275f1e06f1f43bd3ef1c2bf6f40982d44fee31e6bf9bb AS base
RUN apk add --no-cache curl
USER deno
WORKDIR /app
COPY . .
RUN deno cache --frozen main.ts

HEALTHCHECK --start-period=3s --start-interval=5s --interval=5m --timeout=10s \
        CMD curl -f "http://localhost:10001/healthcheck"

CMD ["deno", "task", "start"]
