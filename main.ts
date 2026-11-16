// Entry driver: load every test case from the input directory, render each
// markdown string through parse() in parse.js, and dump the resulting HTML
// strings (same order as the cases) as a JSON array in the output directory.
// Inside the scoring container the paths are /input and /output; locally,
// MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR let the caller override them.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as Array<{ id: string; markdown: string }>;

const rendered: string[] = [];
for (const item of cases) rendered.push(parse(item.markdown));
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
