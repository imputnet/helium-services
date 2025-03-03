#!/bin/sh
set -e

MKBANGS=mkbangs.mjs
BANG_URL_PREFIX=https://raw.githubusercontent.com/kagisearch/bangs/refs/tags/
BANG_URL_SUFFIX=/data/bangs.json

# 0. get latest version
cd "$(dirname "$0")"
echo "getting latest version..."

NEW_VERSION=$(curl https://api.github.com/repos/kagisearch/bangs/releases -s | jq -r '.[0].tag_name')
echo "latest version is $NEW_VERSION"

if grep "VERSION = '$NEW_VERSION'" "$MKBANGS"; then
  echo "no need to bump version, exiting"
  exit 0
fi

# 1. get file checksum
BANG_CHECKSUM=$(curl -s "$BANG_URL_PREFIX$NEW_VERSION$BANG_URL_SUFFIX" | sha256sum | awk '{ print $1 }')
echo "bc: $BANG_CHECKSUM"

# 2. update mkbangs
case $OSTYPE in
  darwin*) SED_CMD=gsed;;
  *) SED_CMD=sed;;
esac

$SED_CMD -i \
"s/VERSION = '.*'/VERSION = '$NEW_VERSION'/g;"\
"s/BANG_CHECKSUM = '.*'/BANG_CHECKSUM = '$BANG_CHECKSUM'/g" \
"$MKBANGS"

# 3. update bangs.json
TMP=$(mktemp)
node $MKBANGS > "$TMP" \
  && chmod 444 "$TMP" \
  && mv -f $TMP ./bangs.json

echo 'git add .; git diff --staged; git commit -m "bangs: update from upstream"'
