# Kety

A desktop app that captures what you work on, notes, screenshots, screen
recordings, dictation and PDFs, indexes it on your own machine, and lets an AI
answer questions about it. You can then export a chosen slice of that index and
hand it to someone else, who opens it as a read-only assistant.

**macOS on Apple Silicon only.** Tauri 2: Rust backend, React + TypeScript
frontend. Apache-2.0.

[**kety.app**](https://kety.app) is the short version of all this, for anyone who
would rather read a page than a README.

---

## What happens to your data

This is the part worth reading first, because it is the part that constrains
everything else.

**There is no Kety server.** The app contacts no host operated by this project.
There is no account, no sign-in, no password, no email. A "profile" is a name
you type, stored in a local file, so that two people sharing a Mac get separate
databases. Nothing syncs.

**There is no telemetry.** No analytics, no crash reporting, no update check, no
startup ping. Nothing in the dependency tree phones home.

Captures live in a per-profile SQLite database under
`~/Library/Application Support/com.kety.desktop/kety/`, alongside the media
files themselves. It is **not encrypted at rest**. Use FileVault if that
matters to you.

### When something does leave the machine

Three cases, all of which you have to turn on:

**Your own OpenAI key.** Every model choice in Settings is per-task: dictation,
transcription, summaries, tagging, sensitive-data scanning, embeddings, the
assistant. Each can run locally or on OpenAI. If you pick an OpenAI model, the
request goes straight from your machine to `api.openai.com` with your key.
There is no relay in between. You pay OpenAI directly.

Two of these deserve to be spelled out, because they are not one-shot:

- If you set the **embedding** model to OpenAI, background indexing sends the
  text of every new capture to OpenAI automatically, with no per-capture
  prompt. Indexing is on by default; the cloud embedding model is not.
- If you set the **assistant** to an OpenAI model, each message makes two
  calls: a `gpt-4o-mini` router pass over your question plus the last few turns,
  then the real request.

The key is stored in plaintext in the local Tauri store. Not in the keychain.

**Model downloads.** Kety ships with no model weights at all. When you install
one from Settings it is fetched from `huggingface.co` (a GET, nothing about you
goes with it). After that, the local path works offline.

**Sharing by link.** Optional. Kety has no storage of its own, so a share link
has to live somewhere you control: you connect **your own** Google Cloud Storage
bucket and service-account key, and the app uploads directly to it. Without a
bucket you can still export to a file and send it however you like.

The Chrome extension can only reach `127.0.0.1` and `localhost`. That is its
entire host allowlist, enforced by the browser.

---

## What it captures

Global shortcuts and a tray menu drive everything; nothing records on its own.

- **Screenshots** and **screen recordings** (ScreenCaptureKit, via a Swift
  helper compiled at build time)
- **Dictation**: a small floating HUD, speech to text, with the result
  insertable into whatever field you were in
- **Notes**: a tray panel for typing context without leaving what you are doing
- **Documents**: drop a PDF in; text is extracted with pdf.js, and pages
  without a text layer are rendered and OCR'd through Vision.framework
- **Google Meet captions**: via the bundled Chrome extension, which posts them
  to the app over loopback

Captures are chunked and embedded in the background shortly after they land, and
become searchable without you pressing anything.

---

## Requirements

- macOS on **Apple Silicon**. There is no Intel build and no Windows or Linux
  build. The local LLM, local embeddings, OCR, screen capture and the
  accessibility layer are all `#[cfg(target_os = "macos")]`; on anything else
  they return an error.
- **Xcode Command Line Tools**: `xcode-select --install`. `build.rs` invokes
  `swiftc` directly.
- **Rust** stable (1.77.2+) and **Node.js 18+**.

## Build

```sh
cd desktop-app/kety-desktop
npm install
npm run tauri dev
```

That is enough for a development build. The first Rust compile takes a while.

A **bundled release build additionally needs the Whisper binary**, because
`vendor/whisper-cli` is listed in `tauri.conf.json` as a bundle resource and
Tauri refuses to package a missing resource:

```sh
bash scripts/setup-whisper.sh   # clones and builds whisper.cpp, then downloads
                                # ggml-medium.bin (about 1.5 GB)
npm run tauri build
```

`npm install` drops a placeholder `vendor/llama-cli` so the bundle resolves;
`bash scripts/setup-llama-cli.sh` replaces it with a real llama.cpp build, which
you need for local text generation and local embeddings.

Checks:

```sh
npx tsc --noEmit -p .                    # from desktop-app/kety-desktop
cargo test --manifest-path src-tauri/Cargo.toml
```

---

## Architecture

```
desktop-app/kety-desktop/
  src/                  React 19 + TypeScript, built by Vite
  src-tauri/src/        Rust, all the actual work
  src-tauri/vendor-src/ Swift helpers compiled by build.rs
  scripts/              setup scripts for whisper.cpp / llama.cpp
mcp-server/             standalone Node MCP server (legacy, see below)
chrome-extension/       MV3 extension for Google Meet captions
shared/                 in-app FAQ copy, one file, aliased as @kety-faq
```

**The split.** The React side is presentation and orchestration; it owns no
data. Everything else (the database, the model subprocesses, capture, the
local HTTP servers) is Rust, exposed as 110 Tauri commands registered in one
block in `src-tauri/src/lib.rs`. The frontend reaches them through `invoke()`;
Rust pushes back through events prefixed `kts:`.

**The index.** One SQLite database per profile, at
`kety/local-index/<profile-id>/index.db`. The schema is small: `captures`,
`chunks`, `chunk_embeddings`, `tags`, `share_links`, `meta`. Text is split into
~2048-character chunks with the overlap stored beside each chunk rather than
inside it, so re-embedding never has to re-read the source. Embeddings are
little-endian f32 blobs, one row per (chunk × model), so switching embedding
models does not destroy the old vectors.

Retrieval is hybrid: cosine similarity computed in Rust, plus BM25 from an FTS5
virtual table (`chunks_fts`, rebuilt from `chunks` on every open), fused with
reciprocal rank fusion. There is no ANN index. The vector side loads every
embedding for the active model into memory and scans. Fine at personal scale,
and the honest reason the search code is as short as it is.

**Models** run as subprocesses, not as linked libraries: `whisper-cli` for
speech, `llama-cli` for generation, `llama-embedding` for embeddings. They are
built from source into `src-tauri/vendor/` by the setup scripts and picked up
from the bundle at runtime. Weights are Whisper GGML and Qwen GGUF, downloaded
on demand.

**MCP.** The live server is `src-tauri/src/mcp_api.rs`. It implements the
Streamable HTTP transport directly in Rust, on `POST 127.0.0.1:47847/mcp`, with
no Node required. It exposes four tools: `check_connection`, `list_assistants`,
`list_tags` and `search`, the last going through the same retrieval path as the
in-app assistant.

Every request needs a bearer token, generated on first run and shown in
Settings, and any request carrying an `Origin` header is refused outright: no
MCP client is a browser, so the header is enough to tell a web page apart from a
real client. Without that, a page you happened to have open could have read your
knowledge base, loopback or not. Settings gives you the `claude mcp add` command
with the token already in it.

**The Meet bridge** is a second loopback server, `meet_bridge.rs` on
`127.0.0.1:17171`, which the Chrome extension posts captions to. This one does
require a bearer token, generated on first run; the app can export a
pre-configured copy of the extension as a ZIP so you never paste it by hand.

**Export/import.** `index_export.rs` builds a ZIP containing a freshly created
database with only the selected captures and their already-computed embeddings,
plus optional media. It is deliberately careful about what travels: metadata is
rebuilt from an allowlist, window and process identifiers are dropped,
`indexed_at` is nulled, and the `zip` crate is pinned with `default-features =
false` so archive entries carry no timestamps from the sender's clock.
`index_import.rs` mounts the result as a separate read-only assistant, a
distinct database the recipient can query but not add to.

**Where to start reading:** `lib.rs` (setup, command registry), then
`local_index.rs` (schema, chunking, retrieval), `auto_index.rs` (the background
loop), `index_export.rs` (the sharing model, and the clearest code in the
repo about what data is considered sensitive).

---

## Known rough edges

Stated plainly, since you would find them anyway:

- **Vestigial sign-in UI.** `AuthModal.tsx` still contains an email/password
  form left over from a removed backend. It is dead (`authContext.tsx` stubs
  `signIn` to a no-op and hardcodes the modal closed), but the file is still
  there, and its "create account" link points at `https://kety.app`, a web app
  that is not part of this repository. Likewise `.env.production` carries a
  `VITE_WEB_APP_URL`. Nothing in the app makes an HTTP request to that host.
- **`mcp-server/`** is a stdio bridge onto the same HTTP API, for clients that
  cannot be pointed at a URL. Claude Desktop is the case that matters: it takes
  a command to run, not an address.
- **`scripts/setup-paddle-ocr.sh`** installs PaddleOCR into a venv. Nothing
  references it; real OCR goes through the Swift Vision helper.
- **`scripts/setup-whisper.sh`** copies your system `ffmpeg` into `vendor/`. It
  is not bundled and no Rust code calls it.
- One of the offered local models, **Qwen2.5-3B-Instruct**, is under the Qwen
  Research License rather than Apache-2.0, which restricts commercial use. See
  `NOTICE`.
- **`kts` is the old name**, from Knowledge Transfer System. The directory and
  the crate are `kety-desktop` now, but events are still `kts:*`, env overrides
  are `KTS_LOCAL_*`, and the screen-capture helper is `kts_screen_capture`.
  Those are internal identifiers, and renaming them buys nothing a reader needs.
- Some older comments in the Rust sources are in French, and a handful of error
  strings still are too. Deliberately left as they are; new code is English.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Pull requests welcome; anything else,
**sam@kety.app**.

## Licence

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
