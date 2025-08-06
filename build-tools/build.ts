import { writeFile } from 'fs/promises';
import { cp, rm, readFile } from 'fs/promises';

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

  // apply build date
  const packageFile = await readFile('./package.json', 'utf-8');
  const packageJSON = JSON.parse(packageFile);

  packageJSON.buildDate = new Date().toISOString();

  await writeFile('./package.json', JSON.stringify(packageJSON, null, 2));

  console.log('[build] Build finished!');
}

build();
