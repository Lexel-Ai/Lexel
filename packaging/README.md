# Lexel Native Packaging

Templates in this directory are rendered strictly from verified `SHA256SUMS.txt` outputs produced during a GitHub Release build. No placeholder or hardcoded checksums are ever committed.

## Included Templates

- `homebrew/lexel.rb.tmpl`: Homebrew formula installing `lexel`, `lexel-daemon`, and `lexel-ls` on macOS Apple Silicon and Linux x86_64.
- `aur/PKGBUILD.tmpl`: Arch Linux AUR `lexel-bin` package installing `lexel`, `lexel-daemon`, and `lexel-ls` from the Linux release tarball.
- `winget/LexelAI.Lexel*.yaml.tmpl`: Winget 1.6 multi-file manifests pointing to the verified Windows x64 MSI installer.

## Rendering Manifests from Release Checksums

```bash
bash scripts/render-packaging.sh \
  --tag v0.2.0 \
  --checksums all-artifacts/SHA256SUMS.txt \
  --out rendered-packaging
```

The script exits with a non-zero status if any required artifact checksum (`lexel-<tag>-linux-x86_64.tar.gz`, `lexel-<tag>-macos-arm64.tar.gz`, `lexel-desktop-windows-x86_64.msi`) is missing or malformed.

## Automated Release & Store Pipelines

- `.github/workflows/release.yml`: builds platform tarballs/installers, writes `SHA256SUMS.txt`, runs `scripts/render-packaging.sh`, and uploads the rendered manifests alongside the GitHub Release assets.
- `.github/workflows/publish-extensions.yml`: builds Chrome MV3, Firefox MV3, and VS Code `.vsix` packages, publishing each only when its corresponding repository secrets (`CHROME_*`, `AMO_JWT_*`, `VSCE_PAT`, `OVSX_PAT`) are configured.
