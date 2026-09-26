# html-converter-for-elementor

Turn HTML files into native, editable **Elementor** templates from the command line.

Headings become Heading widgets, paragraphs become Text Editors, styled links become
Buttons, and layout becomes real Containers with flex or grid settings — not one opaque
HTML block. Spacing, colour, typography and responsive values land on actual Elementor
controls, so the result stays editable in the panel.

This is the same engine that runs on [htmltoelementor.com](https://htmltoelementor.com/),
packaged for scripts and batch migrations.

```bash
npx html-converter-for-elementor page.html
# -> page.json  (import via Templates → Saved Templates → Import)
```

## Install

```bash
npm i -g html-converter-for-elementor
npx playwright install chromium
```

The second command is required. See [Why it needs a browser](#why-it-needs-a-browser).

## Usage

```bash
# one file, JSON template next to it
html-converter-for-elementor hero.html

# a whole folder into one output directory
html-converter-for-elementor src/*.html -o build/

# Elementor paste data instead of a template file
html-converter-for-elementor hero.html --clipboard -o hero.paste.json

# map icon fonts and ✓-style characters onto the Elementor icon library
# (needed for Icon List / Icon Box output)
html-converter-for-elementor cards.html --icons elementor
```

| Option | Values | Default |
|---|---|---|
| `-o, --out` | file or directory | next to the input |
| `--clipboard` | — | off (writes a JSON template) |
| `--mode` | `native`, `fidelity` | `native` |
| `--icons` | `svg`, `elementor` | `svg` |
| `--images` | `placeholder`, `preserve` | `placeholder` |
| `--colors` | `preserve`, `site` | `preserve` |
| `--fonts` | `preserve`, `site` | `preserve` |
| `--title` | text | the file name |

## What happens on the network

The conversion runs on your machine. **Your HTML is never uploaded** — there is no
account, no API key, no telemetry and no conversion limit. The engine is served to the
local browser by a temporary HTTP server bound to `127.0.0.1` on a random port, closed
when the run finishes.

There is exactly one caveat, and it is worth stating plainly rather than burying:

**Remote `<img src>` URLs are kept on purpose, so the browser fetches those images while
rendering.** That is deliberate — a Media Library URL is the recommended way to carry
images across, and the image has to load for its size to be measured. But it does mean
the host serving that image sees a request.

Everything else that could reach out is stripped *before* rendering: external
stylesheets, `@font-face` sources, `url()` in CSS, iframes and scripts.

Every run prints the hosts that were contacted:

```
contacted 1 remote host while rendering: upload.wikimedia.org
pass --no-remote to block them
```

Use `--no-remote` for client work or an air-gapped machine. Images then fail to load, so
their dimensions come from the markup rather than from measurement — slightly less
accurate, completely isolated.

## Why it needs a browser

The engine does not parse your CSS. It **renders the page and reads the styles the
browser actually computed** — which is the only way cascade order, media queries and
utility-class frameworks resolve correctly. It also measures real geometry
(`getBoundingClientRect` is used in 43 places) to infer widths, alignment and
responsive values at several viewport sizes.

`jsdom` cannot do this: it implements no layout, so every measurement comes back zero.
Using it would not make the output slightly worse — it would make it wrong. So the CLI
drives a headless Chromium through `playwright-core`.

## What does not convert, and why

Honest limits, the same as the web tool:

- **Scripts** are stripped. Importing arbitrary JS through a template is unsafe.
- **External stylesheets** are removed — inline your CSS or keep it in a `<style>` block,
  or the page renders unstyled and unstyled is what gets converted.
- **Form submit actions** are dropped; reconnect with an Elementor Form widget.
- **Hover/focus states, animations, CSS counters and `::before`/`::after` content**
  cannot be read from a static page. No converter can infer them.
- **Local paths and Base64 images** cannot become Media Library attachments, so they
  arrive as labelled placeholders. Upload the files first and reference those URLs.

The run reports what it removed or rewrote instead of dropping it silently.

## Keeping the engine in step

The engine is copied from the website, never re-implemented — that is the whole point of
this package, and two hand-maintained copies would drift.

```bash
npm run sync-engine    # copies converter.js + elementor-components.js, records sha256
```

`src/engine/ENGINE_SHA.json` records the hashes that shipped, so any output can be traced
to an exact engine build.

## License

The CLI wrapper is MIT. The bundled conversion engine is proprietary and redistributed
here for use with this tool — see [LICENSE](LICENSE).
