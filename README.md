# markdown-render-speed-02

Fast drop-in replacement for **marked 18.1.3** — entry for the [make.fun](https://make.fun) bounty **markdown-render-speed-02**.

Built by [Bangzo1708](https://github.com/Bangzo1708) for make.fun — referral code `dkj7ja9h`.

## What it is

A single-file Markdown parser/renderer (`parse.js`, ~1,500 lines) that is API-compatible with marked 18.1.3 for the bounty practice set, tuned for raw rendering speed:

- 720/720 cases pass on the practice set
- ~1.16x faster than the marked baseline

## Usage

```ts
import { parse } from "./parse.js";

const html = parse("# Hello\n\nSome *markdown* text.");
```

`main.ts` is the thin entry point used by the bounty harness.

## License

MIT — see [LICENSE](LICENSE).
