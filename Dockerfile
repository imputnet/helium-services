FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS base
WORKDIR /app

FROM base AS build
ENV pnpm_config_store_dir=/pnpm/store
WORKDIR /repo
COPY package.json ./
RUN corepack enable && corepack install
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile \
        --filter . --filter @helium-services/common \
    && pnpm --filter @helium-services/common build \
    && for dir in svc/*/ util/*/; do \
        [ -f "$dir/package.json" ] || continue; \
        pnpm --filter "./$dir" deploy --prod "/out/$(basename "$dir")"; \
    done

FROM base AS service
RUN apk add --no-cache curl

FROM service AS extension-proxy
USER node
COPY --from=build /out/extension-proxy ./
HEALTHCHECK --start-period=3s --start-interval=5s --interval=5m --timeout=10s \
        CMD curl -f "http://localhost:8000/?response=redirect&x=id%3Daeblfdkhhhdcdjpifhhbdiojplfjncoa%26uc"
CMD ["node", "--conditions=production", "main.ts"]

FROM service AS minipush
USER node
COPY --from=build /out/minipush ./
HEALTHCHECK --start-period=3s --start-interval=5s --interval=5m --timeout=10s \
        CMD curl -f "http://localhost:10001/healthcheck"
CMD ["node", "--conditions=production", "main.ts"]

FROM service AS ubo
USER node
COPY --from=build /out/ubo ./
HEALTHCHECK --start-period=3s --start-interval=5s --interval=5m --timeout=10s \
        CMD curl --compressed -f "http://localhost:8000/assets.json"
CMD ["node", "--conditions=production", "main.ts"]

FROM base AS release-collector
USER node
COPY --from=build /out/release-collector ./
ENTRYPOINT ["node", "--conditions=production", "main.ts"]

FROM base AS sparkler
USER node
COPY --from=build /out/sparkler ./
ENTRYPOINT ["node", "--conditions=production", "main.ts"]
