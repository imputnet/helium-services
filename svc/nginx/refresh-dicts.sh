#!/bin/sh
set -o pipefail

DICT_TARBALL="https://chromium.googlesource.com/chromium/deps/hunspell_dictionaries/+archive/refs/heads/main.tar.gz"
DICT_DIR="/dev/shm/dictionaries/"

cleanup() {
    mkdir -p "$DICT_DIR/dict"
    rm -rf "$DICT_DIR/tmp"
    rm -rf "$DICT_DIR/tmp2"
}

do_refresh() {
    cleanup

    mkdir -p "$DICT_DIR/tmp" \
    && cd "$DICT_DIR/tmp" \
    && curl -s "$DICT_TARBALL" | tar xz \
    && find . -type f -not -name '*.gz' -exec gzip -9 {} \; \
    && mv "$DICT_DIR/dict" "$DICT_DIR/tmp2" \
    && mv "$DICT_DIR/tmp" "$DICT_DIR/dict"

    cleanup
}

while :; do
    do_refresh
    echo "done refreshing dictionaries"
    sleep 86400
done
