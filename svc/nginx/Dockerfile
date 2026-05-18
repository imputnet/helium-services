FROM alpine:3.22.4@sha256:310c62b5e7ca5b08167e4384c68db0fd2905dd9c7493756d356e893909057601 AS prep
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
