#!/bin/sh
export SSL_CERT_PATH="/certs/fullchain.pem"
export NGINX_CONF="/tmp/nginx.conf"

: "${SERVICES_HOSTNAME:?}"
sed "s/{{ services_hostname }}/$SERVICES_HOSTNAME/" /nginx.conf.j2 > "$NGINX_CONF" || exit 1

./refresh-bangs.sh &
./refresh-dicts.sh &

echo -en "waiting for ssl cert at $SSL_CERT_PATH"
while ! [ -f "$SSL_CERT_PATH" ]; do
    echo -en .
    sleep 1
done

echo " cert ok!"

echo -en "waiting for all hosts to come up";
while ! nginx -c "$NGINX_CONF" -t >/dev/null 2>/dev/null; do
    echo -en .
    sleep 0.1
done
echo " ready!"

./refresh-cert.sh &
nginx -c "$NGINX_CONF"

