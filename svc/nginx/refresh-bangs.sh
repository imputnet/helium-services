#!/bin/sh

BANG_SOURCE="https://raw.githubusercontent.com/imputnet/helium-services/refs/heads/main/svc/bangs/bangs.json"
TMPFILE_PATH="/dev/shm/bangs/temp.txt"
OUTFILE_PATH="/dev/shm/bangs/bangs.json"

mkdir -p "$(dirname "$OUTFILE_PATH")"
[ -f "$OUTFILE_PATH" ] || touch "$OUTFILE_PATH";

while :; do
    curl --fail -m 5 \
         -o "$TMPFILE_PATH" \
         -z "$OUTFILE_PATH" \
         "$BANG_SOURCE" \
    && gzip -k9 "$TMPFILE_PATH" \
    && mv "$TMPFILE_PATH" "$OUTFILE_PATH" \
    && mv "$TMPFILE_PATH.gz" "$OUTFILE_PATH.gz"

    sleep 3600
done
