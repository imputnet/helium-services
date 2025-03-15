#!/bin/sh
set -xae
. ./.env
set +a

docker compose build \
  && docker compose up -d

alias acme="docker compose exec acme.sh"

# making a snakeoil cert first so that nginx can start up
acme openssl genrsa -out /certs/private.key 2048

acme \
    openssl req -new -key /certs/private.key -out /tmp/cert.csr \
    -subj "/C=AU/ST=Some-State/L=/O=Internet Widgits Pty Ltd/OU=/CN=$SERVICES_HOSTNAME"

acme \
    openssl x509 -req -days 7 \
      -in /tmp/cert.csr \
      -signkey /certs/private.key \
      -out /certs/fullchain.pem

acme --set-default-ca --server letsencrypt
acme --register-account -m "$SSL_CERT_EMAIL"

acme \
    --issue -w /webroot/ \
    --keylength ec-384 \
    --server letsencrypt \
    -d "$SERVICES_HOSTNAME"

acme \
    --install-cert \
    --fullchain-file /certs/fullchain.pem \
    --key-file /certs/private.key \
    -d "$SERVICES_HOSTNAME"

echo "done!"
