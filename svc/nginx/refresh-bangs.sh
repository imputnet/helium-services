#!/bin/sh

BANG_SOURCE="https://raw.githubusercontent.com/imputnet/helium-services/refs/heads/main/svc/bangs/bangs.json"
TMPFILE_PATH="/dev/shm/bangs/temp.txt"
OUTFILE_PATH="/dev/shm/bangs/bangs.json"

mkdir -p "$(dirname "$OUTFILE_PATH")"
[ -f "$OUTFILE_PATH" ] || touch "$OUTFILE_PATH";

while :; do
    curl -m 5 \
         -o "$TMPFILE_PATH" \
         -z "$OUTFILE_PATH" \
         "$BANG_SOURCE" \
    && mv "$TMPFILE_PATH" "$OUTFILE_PATH"

    sleep 3600
done
