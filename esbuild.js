const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['src/extension.ts'],
  outfile: 'dest/extension.js',
  bundle: true,
  platform: 'node',
  sourcemap: true
}).catch(() => process.exit(1));
