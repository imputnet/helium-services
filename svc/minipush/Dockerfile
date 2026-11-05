FROM denoland/deno:alpine-2.9.8@sha256:75749604f68aea01d39bead15fd1c86343639e44eb8c58ab051da8a924799d01 AS base
RUN apk add --no-cache curl
USER deno
WORKDIR /app
COPY . .
RUN deno cache --frozen main.ts

HEALTHCHECK --start-period=3s --start-interval=5s --interval=5m --timeout=10s \
        CMD curl -f "http://localhost:10001/healthcheck"

CMD ["deno", "task", "start"]
