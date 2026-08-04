#!/bin/sh
set -euxo pipefail

DICT_COMMIT="cccf64a8acc951afe3f47fee023908e55699bc58"
DICT_TARBALL="https://chromium.googlesource.com/chromium/deps/hunspell_dictionaries/+archive/$DICT_COMMIT.tar.gz"
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
    && mv "$DICT_DIR/tmp" "$DICT_DIR/dict" \
    && cleanup
}

for i in 1 2 3; do
    do_refresh && break
    sleep 10
done
