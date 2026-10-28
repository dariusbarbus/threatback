import { copyFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir('release', { recursive: true });
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian'],
  format: 'cjs',
  target: 'es2020',
  outfile: 'release/main.js',
  minify: true,
  banner: { js: '/* Threatback | MIT License */' },
});
await Promise.all(
  ['manifest.json', 'styles.css'].map(name => copyFile(name, `release/${name}`)),
);
