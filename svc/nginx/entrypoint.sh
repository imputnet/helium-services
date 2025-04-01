#!/bin/sh
export SSL_CERT_PATH="/certs/fullchain.pem"

./refresh-bangs.sh &
./refresh-dicts.sh &

echo -en "waiting for ssl cert at $SSL_CERT_PATH"
while ! [ -f "$SSL_CERT_PATH" ]; do
    echo -en .
    sleep 1
done

echo " cert ok!"

echo -en "waiting for all hosts to come up";
while ! nginx -t >/dev/null 2>/dev/null; do
    echo -en .
    sleep 0.1
done
echo " ready!"

./refresh-cert.sh &
nginx

