import { cp } from 'fs/promises';
import { rm } from 'fs/promises';

async function build() {
  // clean dist
  await rm('dist', { recursive: true, force: true });

  // bundle code
  await Bun.build({
    entrypoints: ['src/index.ts'],
    outdir: 'dist',
    target: 'bun',
  });

  await cp('src/pages', 'dist/pages', { recursive: true });
  await cp('src/public', 'dist/public', { recursive: true });

  console.log('[build] Build finished!');
}

build();
