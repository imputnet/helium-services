FROM denoland/deno:alpine-2.7.14@sha256:f36b916d304948316d9af285dba7949be6e17ed56af8b90b389295bcf4326cba AS base
RUN apk add --no-cache curl
USER deno

FROM base AS builder

WORKDIR /app
COPY . .
RUN deno cache main.ts

HEALTHCHECK --start-period=3s --start-interval=5s --interval=5m --timeout=10s \
        CMD curl -f "http://localhost:8000/?response=redirect&x=id%3Daeblfdkhhhdcdjpifhhbdiojplfjncoa%26uc"

CMD ["deno", "task", "run"]
