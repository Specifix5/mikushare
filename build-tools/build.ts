import { writeFile } from 'fs/promises';
import { cp, rm, readFile, readdir } from 'fs/promises';
import { MAX_FILE_SIZE, MAX_TEMP_FILE_SIZE } from '../src/utils/constants';

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

  // replace all places of {%maxSize%} and {%maxTempSize%} in public/scripts
  const files = await readdir('dist/public/scripts');
  for (const file of files) {
    const filePath = `dist/public/scripts/${file}`;
    if (file.endsWith('.js')) {
      let content = await readFile(filePath, 'utf-8');
      content = content.replace(/{%maxSize%}/g, String(MAX_FILE_SIZE));
      content = content.replace(/{%maxTempSize%}/g, String(MAX_TEMP_FILE_SIZE));
      await writeFile(filePath, content);
    }
  }

  // apply build date
  const packageFile = await readFile('./package.json', 'utf-8');
  const packageJSON = JSON.parse(packageFile);

  packageJSON.buildDate = new Date().toISOString();

  await writeFile('./package.json', JSON.stringify(packageJSON, null, 2));

  console.log('[build] Build finished!');
}

build();
