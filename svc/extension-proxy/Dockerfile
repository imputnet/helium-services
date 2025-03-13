FROM denoland/deno:alpine-2.2.3 AS builder
WORKDIR /app
COPY . .
RUN deno cache main.ts

FROM denoland/deno:alpine-2.2.3
WORKDIR /app
COPY --from=builder /app .
CMD ["deno", "task", "run"]
