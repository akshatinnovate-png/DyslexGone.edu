// Bundles the pure-computation engines for the static demo site.
//
// The site runs on GitHub Pages, so there is no server and no Node. Two
// modules in src/core reach for node:crypto and node:fs; an onResolve hook
// swaps those two files - and only those two - for browser shims with the
// same contracts. Everything else in the bundle is the production source,
// unmodified, so the demo cannot drift from the backend it demonstrates.
import { build } from 'esbuild';
import { mkdir, copyFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'site');

const SHIMS = {
  [resolve(root, 'src/core/ids.ts')]: resolve(root, 'web/shims/ids.ts'),
  [resolve(root, 'src/core/config.ts')]: resolve(root, 'web/shims/config.ts'),
};

/** Redirects the two node-dependent core modules to their browser shims. */
const shimPlugin = {
  name: 'browser-shims',
  setup(b) {
    b.onResolve({ filter: /\/core\/(ids|config)(\.js|\.ts)?$/ }, (args) => {
      const base = args.importer ? dirname(args.importer) : root;
      const asTs = resolve(base, args.path).replace(/\.js$/, '.ts');
      const shim = SHIMS[asTs];
      return shim ? { path: shim } : undefined;
    });
    // Anything still reaching for node: builtins is a bug, not something to
    // paper over with an empty stub - fail the build loudly instead.
    b.onResolve({ filter: /^node:/ }, (args) => ({
      errors: [{ text: `node builtin "${args.path}" reached the browser bundle via ${args.importer}` }],
    }));
  },
};

await mkdir(out, { recursive: true });

const result = await build({
  entryPoints: [resolve(root, 'web/entry.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  sourcemap: false,
  globalName: undefined,
  outfile: join(out, 'engine.js'),
  plugins: [shimPlugin],
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
  metafile: true,
});

// Copy the hand-written site assets over the build output.
async function copyTree(from, to) {
  await mkdir(to, { recursive: true });
  for (const name of await readdir(from)) {
    const src = join(from, name);
    if ((await stat(src)).isDirectory()) await copyTree(src, join(to, name));
    else await copyFile(src, join(to, name));
  }
}
await copyTree(resolve(root, 'web/public'), out);

const bytes = Object.values(result.metafile.outputs).reduce((a, o) => a + o.bytes, 0);
console.log(`site/engine.js  ${(bytes / 1024).toFixed(1)} kB`);
