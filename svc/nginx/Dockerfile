FROM nginx:1.30.7-alpine3.24-slim@sha256:8c950211a641ec5b23f265450517001f6bcca533666120ebe36cb4cff3d00a55

RUN apk add --no-cache inotify-tools curl

COPY nginx.conf.j2 *.sh /

HEALTHCHECK CMD \
    curl -f \
    --resolve "${SERVICES_HOSTNAME}:443:127.0.0.1" \
    -o /dev/null \
    "https://${SERVICES_HOSTNAME}/bangs.json"

ENTRYPOINT ["/entrypoint.sh"]
