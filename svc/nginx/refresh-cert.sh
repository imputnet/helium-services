#!/bin/sh

if [ "$SSL_CERT_PATH" = "" ]; then
    echo "wtf?" >&2
    exit 1
fi

inotifywait -m -e close_write "$SSL_CERT_PATH" |
while read event; do
    echo "reloading nginx rn"
    nginx -s reload
done
