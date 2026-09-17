# Contributing

## Build

Kety builds on macOS with Apple Silicon. You need:

- **Xcode Command Line Tools**: `xcode-select --install`. `src-tauri/build.rs` shells
  out to `swiftc` to compile the ScreenCaptureKit and Vision helpers, so the build
  fails without them.
- **Rust** (stable, 1.77.2 or newer): https://rustup.rs
- **Node.js 18 or newer**
- **cmake**: `brew install cmake`, for the llama.cpp and whisper.cpp builds

Then:

```sh
cd desktop-app/kety-desktop
npm install
bash scripts/setup.sh
npm run tauri dev
```

`setup.sh` builds the vendored binaries, which are not in the repository. The
whisper step downloads about 1.5 GB of weights; `--no-whisper` skips it, at the
cost of dictation and of being able to run `npm run tauri build`. The README
explains what each binary is and where it comes from. The first Rust build takes
a while.

Before opening a pull request:

```sh
npx tsc --noEmit -p .                    # from desktop-app/kety-desktop
cargo test --manifest-path src-tauri/Cargo.toml
```

## Pull requests

Pull requests are welcome. Some things worth knowing:

- Everything written into the repo is in **English** (identifiers, comments,
  commit messages, user-facing strings). Some older Rust comments are in French;
  leave them alone rather than translating them in passing.
- Keep the change and its explanation in the same place. Several non-obvious
  decisions in this codebase are recorded as comments next to the code they
  constrain (see the `zip` dependency in `src-tauri/Cargo.toml` for the style).
- Anything that changes what leaves the machine (a new network call, a new
  upload path, a new field in an export) should say so explicitly in the pull
  request description.

## Anything else

Email **sam@kety.app**.

By contributing you agree that your contributions are licensed under the
Apache License 2.0, the same terms as the rest of the project.
