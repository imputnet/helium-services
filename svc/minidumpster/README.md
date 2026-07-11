# minidumpster

Crash reporting handler used by Helium for Crashpad minidump uploads, hosted on
https://crash.helium.computer.

### privacy policy

this service collects crash reports submitted by Helium. these reports contain
technical information about the crashed process and system, including the Helium
version, operating system, architecture, crash annotations and stack or memory
data captured by crashpad. because crash reports may contain fragments of
process memory, they may unintentionally contain personal or otherwise sensitive
data.

crash reports are used only to diagnose and group Helium crashes. raw reports
are kept for 30 days by default, after which they are deleted. derived metadata
and symbolicated stack traces may be retained for longer so regressions can be
tracked across releases. access to reports is restricted to active members of
the imputnet GitHub organization.

client IP addresses are used temporarily for rate limiting and are not stored by
this service. logs contain report identifiers and technical build or processing
information, but do not contain crash dumps or arbitrary crash annotations.

## setup

```sh
cp .env.example .env
# fill in all required field (see inline comments for help)

mkdir -p data
docker compose up -d --build
```

## usage

point `CrashReporterClient::GetUploadUrl()` to `https://$hostname/crash`

## uploading symbols

```sh
# zip up debug files
# - pdb + exe/dlls on windows
# - dSYMs on macOS
# - unstripped ELF binaries on linux
zip -r symbols.zip out/Release/*.pdb out/Release/mybrowser.exe ...

curl -sS -X POST \
  -H "Authorization: Bearer $SYMBOL_UPLOAD_TOKEN" \
  --data-binary @symbols.zip \
  "https://$hostname/api/symbols?product=mybrowser&version=138.0.1.0"
```

[@getsentry/symbolicator]: https://github.com/getsentry/symbolicator
