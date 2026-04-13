## winsparkler

Generates WinSparkle appcasts for Helium Windows releases.

The tool reads GitHub releases from `imputnet/helium-windows`, optionally
mirrors installer assets locally, and writes:

- `appcast-x64.xml`
- `appcast-arm64.xml`

### environment

See [.env.example](.env.example).

### usage

```sh
deno run -A main.ts
```
