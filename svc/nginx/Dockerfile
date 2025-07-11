FROM alpine:3.21.3@sha256:a8560b36e8b8210634f77d9f7f9efd7ffa463e380b75e2e74aff4511df3ef88c AS prep
ARG SERVICES_HOSTNAME

RUN apk add --no-cache jinja2-cli

COPY ./nginx/*.j2 /
COPY ./nginx/template.sh /
COPY ./ubo/gen/ /

RUN test -n "$SERVICES_HOSTNAME"
RUN /template.sh

FROM nginx:1.26.3-alpine3.20-slim@sha256:b72dec66dea425356956e863bfbccca6c1f8748f5913e094d4ca20b71e4ba2c3
ARG SERVICES_HOSTNAME
ENV SERVICES_HOSTNAME "$SERVICES_HOSTNAME"

RUN apk add --no-cache inotify-tools curl
RUN curl https://ssl-config.mozilla.org/ffdhe4096.txt -o /etc/nginx/dhparam.pem

COPY --from=prep /*.conf /etc/nginx/
COPY --from=prep /assets.json /usr/share/ublock/ubo/
COPY --from=prep /update.xml /usr/share/ublock/ubo/
COPY ./ubo/gen/crx_info.txt /
COPY ./nginx/*.sh /

RUN head -n 1 /crx_info.txt | xargs curl -L -o /usr/share/ublock/ubo/ublock.crx
RUN tail -n 1 /crx_info.txt | sha256sum -c

HEALTHCHECK CMD \
    curl -f \
    --resolve "${SERVICES_HOSTNAME}:443:127.0.0.1" \
    -o /dev/null \
    "https://${SERVICES_HOSTNAME}/bangs.json"

ENTRYPOINT ["/entrypoint.sh"]
