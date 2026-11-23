FROM nginx:1.30.7-alpine3.24-slim@sha256:4e48c17c655fc5e3bded909a60ff5a710457746591b03ddaab046984e97a56a3

RUN apk add --no-cache inotify-tools curl

COPY nginx.conf.j2 *.sh /

HEALTHCHECK CMD \
    curl -f \
    --resolve "${SERVICES_HOSTNAME}:443:127.0.0.1" \
    -o /dev/null \
    "https://${SERVICES_HOSTNAME}/bangs.json"

ENTRYPOINT ["/entrypoint.sh"]
