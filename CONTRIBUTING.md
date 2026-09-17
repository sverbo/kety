# Contributing

## Build

Kety builds on macOS with Apple Silicon. You need:

- **Xcode Command Line Tools** — `xcode-select --install`. `src-tauri/build.rs` shells
  out to `swiftc` to compile the ScreenCaptureKit and Vision helpers, so the build
  fails without them.
- **Rust** (stable, 1.77.2 or newer) — https://rustup.rs
- **Node.js 18 or newer**

Then:

```sh
cd desktop-app/kts-desktop
npm install
npm run tauri dev
```

The first Rust build takes a while. `npm run tauri dev` does not need the Whisper
binary; a bundled release build does:

```sh
bash scripts/setup-whisper.sh   # builds whisper.cpp, downloads ~1.5 GB of weights
npm run tauri build
```

Before opening a pull request:

```sh
npx tsc --noEmit -p .                    # from desktop-app/kts-desktop
cargo test --manifest-path src-tauri/Cargo.toml
```

## Pull requests

Pull requests are welcome. Some things worth knowing:

- Everything written into the repo is in **English** — identifiers, comments,
  commit messages, user-facing strings. Some older Rust comments are in French;
  leave them alone rather than translating them in passing.
- Keep the change and its explanation in the same place. Several non-obvious
  decisions in this codebase are recorded as comments next to the code they
  constrain (see the `zip` dependency in `src-tauri/Cargo.toml` for the style).
- Anything that changes what leaves the machine — a new network call, a new
  upload path, a new field in an export — should say so explicitly in the pull
  request description.

## Anything else

Email **sam@kety.app**.

By contributing you agree that your contributions are licensed under the
Apache License 2.0, the same terms as the rest of the project.
