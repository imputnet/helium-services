#!/bin/sh
set -euxo pipefail

# dictionary filenames are versioned (e.g. en-US-10-1.bdic vs en-US-10-2.bdic),
# and helium builds on different chromium versions request different ones, so
# files from several commits are served side by side. newer commits go last,
# so that they win for files which exist in more than one.
# - cccf64a8: last commit with the -10-1 english dictionaries, for chromium 151
# - cee14e31: -10-2 english dictionaries, pinned in the DEPS of chromium 154
DICT_COMMITS="
    cccf64a8acc951afe3f47fee023908e55699bc58
    cee14e319bb7603a1157bb4d1e216be64ee82b77
"
DICT_ARCHIVE_URL="https://chromium.googlesource.com/chromium/deps/hunspell_dictionaries/+archive"
DICT_DIR="/dev/shm/dictionaries/"

cleanup() {
    mkdir -p "$DICT_DIR/dict"
    rm -rf "$DICT_DIR/tmp"
    rm -rf "$DICT_DIR/tmp2"
}

do_refresh() {
    cleanup

    mkdir -p "$DICT_DIR/tmp" && cd "$DICT_DIR/tmp" || return 1

    # each archive is extracted on its own and only merged in once complete,
    # so one failed download doesn't hold back the others, and a partial
    # extraction is never served. an incomplete refresh still publishes what
    # it got, and returns non-zero so that it's retried.
    incomplete=0
    for commit in $DICT_COMMITS; do
        rm -rf "$DICT_DIR/archive"
        mkdir "$DICT_DIR/archive" \
        && curl -s "$DICT_ARCHIVE_URL/$commit.tar.gz" | tar xz -C "$DICT_DIR/archive" \
        && cp -a "$DICT_DIR/archive/." . \
        || incomplete=1
    done
    rm -rf "$DICT_DIR/archive"

    [ -n "$(ls -A)" ] || return 1

    find . -type f -not -name '*.gz' -exec gzip -9 {} \; \
    && mv "$DICT_DIR/dict" "$DICT_DIR/tmp2" \
    && mv "$DICT_DIR/tmp" "$DICT_DIR/dict" \
    && cleanup \
    && [ "$incomplete" = 0 ]
}

for i in 1 2 3; do
    do_refresh && break
    sleep 10
done
