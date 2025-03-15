FROM alpine:3.21.3@sha256:a8560b36e8b8210634f77d9f7f9efd7ffa463e380b75e2e74aff4511df3ef88c AS prep
ARG SERVICES_HOSTNAME

RUN apk add --no-cache jinja2-cli openssl
RUN openssl dhparam -out /dhparam.pem 4096

COPY nginx.conf.j2 /nginx.conf.j2

RUN test -n "$SERVICES_HOSTNAME"
RUN jinja2 --strict \
    -D "services_hostname=$SERVICES_HOSTNAME" \
    /nginx.conf.j2 -o /nginx.conf

FROM nginx:1.26.3-alpine3.20-slim@sha256:b72dec66dea425356956e863bfbccca6c1f8748f5913e094d4ca20b71e4ba2c3

RUN apk add --no-cache inotify-tools curl

COPY --from=prep /dhparam.pem /etc/nginx/dhparam.pem
COPY --from=prep /nginx.conf /etc/nginx/nginx.conf
COPY ./*.sh /

ENTRYPOINT ["/entrypoint.sh"]
