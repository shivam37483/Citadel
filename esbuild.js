// This file is using esbuild, a fast JavaScript bundler and minifier, to compile the TypeScript file (src/extension.ts) into JavaScript (dest/extension.js).

const esbuild = require('esbuild');

// process.argv returns an array containing the arguments sent while executing node on command-line. We are identifying whther these 2 parameters were present.
const production = process.argv.includes('--production');      // Boolean
const watch = process.argv.includes('--watch');                // Boolean


async function build() {
  const context = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    outfile: 'dest/extension.js',
    bundle: true,
    external: ['vscode'],            // Excludes the vscode module from the bundle
    platform: 'node',                // Specifies that the output is for Node.js
    sourcemap: !production,          // Generates a source map (dest/extension.js.map) only if production is not present
    format: 'cjs',
    minify: production,               
    treeShaking: true,               // Removes unused code for optimization
  })

  
  if (watch) {
    console.log('[watch] Initial build finished, watching for changes...');
    await context.watch();
    console.log('[watch] build finished, watching for changes...');
  } else {
    await context.rebuild();         // Performs a one-time build
    await context.dispose();         // Cleans up resources after building
    console.log('[build] build finished');
  }
}


build().catch((err) => {
  console.log(err);
  process.exit(1);
});
