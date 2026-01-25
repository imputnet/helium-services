#!/bin/sh
set -e

CONSTANTS_FILE=lib/assets-info.ts

RELEASE_URL0=https://raw.githubusercontent.com/
RELEASE_URL1=/refs/tags/
RELEASE_URL2=/assets/assets.json

# 0. get latest version
cd "$(dirname "$0")"
echo "getting latest version..."

case $OSTYPE in
  darwin*) SED_CMD=gsed;;
  *) SED_CMD=sed;;
esac

do_check() {
  repo="$1"
  kind="$2"

  NEW_VERSION=$(
    curl "https://api.github.com/repos/$repo/releases/latest" -s \
    | jq -r .tag_name)
  echo "$kind: latest version is $NEW_VERSION"

  if grep "VERSION_$kind = '$NEW_VERSION'" "$CONSTANTS_FILE"; then
    echo "no need to bump version for $kind"
    return
  fi

  # 1. get file checksum
  ASSETS_URL="$RELEASE_URL0$repo$RELEASE_URL1$NEW_VERSION$RELEASE_URL2"
  echo "$kind: $ASSETS_URL"
  FILE_CHECKSUM=$(curl -s "$ASSETS_URL" | sha256sum | awk '{ print $1 }')
  echo "sha256($kind): $FILE_CHECKSUM"

  # 2. update generation script
  $SED_CMD -i \
  "s/VERSION_$kind = '.*'/VERSION_$kind = '$NEW_VERSION'/g;"\
  "$CONSTANTS_FILE"

  $SED_CMD -Ezi \
  "s/(CSUM_$kind =\s*)'[^']*'/\1'$FILE_CHECKSUM'/g" \
  "$CONSTANTS_FILE"
}

do_check gorhill/uBlock VANILLA
do_check imputnet/uBlock HELIUM

echo 'git add .; git diff --staged; git commit -m "ubo-filters: update from upstream"'
