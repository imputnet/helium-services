#!/bin/sh
set -e

GENERATE_SCRIPT=lib/ublock.ts
RELEASE_URL_PREFIX=https://raw.githubusercontent.com/gorhill/uBlock/refs/tags/
RELEASE_URL_SUFFIX=/assets/assets.json

# 0. get latest version
cd "$(dirname "$0")"
echo "getting latest version..."

NEW_VERSION=$(curl https://api.github.com/repos/gorhill/uBlock/releases/latest -s | jq -r .tag_name)
echo "latest version is $NEW_VERSION"

if grep "VERSION = '$NEW_VERSION'" "$GENERATE_SCRIPT"; then
  echo "no need to bump version, exiting"
  exit 0
fi

# 1. get file checksum
echo "$RELEASE_URL_PREFIX$NEW_VERSION$RELEASE_URL_SUFFIX"
FILE_CHECKSUM=$(curl -s "$RELEASE_URL_PREFIX$NEW_VERSION$RELEASE_URL_SUFFIX" | sha256sum | awk '{ print $1 }')
echo "sha256: $FILE_CHECKSUM"

# 2. update generation script
case $OSTYPE in
  darwin*) SED_CMD=gsed;;
  *) SED_CMD=sed;;
esac

$SED_CMD -i \
"s/VERSION = '.*'/VERSION = '$NEW_VERSION'/g;"\
"s/FILE_CHECKSUM = '.*'/FILE_CHECKSUM = '$FILE_CHECKSUM'/g" \
"$GENERATE_SCRIPT"

echo 'git add .; git diff --staged; git commit -m "ubo-filters: update from upstream"'
