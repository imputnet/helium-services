FROM alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a AS prep
ARG SERVICES_HOSTNAME

RUN apk add --no-cache jinja2-cli

COPY ./nginx/*.j2 /
COPY ./nginx/template.sh /

RUN test -n "$SERVICES_HOSTNAME"
RUN /template.sh

FROM nginx:1.30.7-alpine3.24-slim@sha256:4e48c17c655fc5e3bded909a60ff5a710457746591b03ddaab046984e97a56a3
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
