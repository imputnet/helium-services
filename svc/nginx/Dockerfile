FROM alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a AS prep
ARG SERVICES_HOSTNAME

RUN apk add --no-cache jinja2-cli

COPY ./nginx/*.j2 /
COPY ./nginx/template.sh /

RUN test -n "$SERVICES_HOSTNAME"
RUN /template.sh

FROM nginx:1.30.1-alpine3.23-slim@sha256:a5688ea5d06cccc298505dddac20e8e28bfe7de67b015a374006593bc23700b1
ARG SERVICES_HOSTNAME
ENV SERVICES_HOSTNAME "$SERVICES_HOSTNAME"

RUN apk add --no-cache inotify-tools curl

COPY --from=prep /*.conf /etc/nginx/
COPY ./nginx/*.sh /

HEALTHCHECK CMD \
    curl -f \
    --resolve "${SERVICES_HOSTNAME}:443:127.0.0.1" \
    -o /dev/null \
    "https://${SERVICES_HOSTNAME}/bangs.json"

ENTRYPOINT ["/entrypoint.sh"]
