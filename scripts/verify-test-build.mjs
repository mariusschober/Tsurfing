import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('dist/client');
const files = [];

const visit = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(target);
    else files.push(target);
  }
};

await visit(root);
const contents = await Promise.all(files.map((file) => readFile(file, 'utf8')));
const bundle = contents.join('\n');

if (!bundle.includes('123456')) throw new Error('The test build does not contain the configured test gate.');
if (!bundle.includes('goalflow-test-access')) throw new Error('The test build does not contain the isolated access marker.');
if (!bundle.includes('Tsurfing Test')) throw new Error('The test build does not contain the test-build marker.');
console.log(`Test build verification passed across ${files.length} built files.`);
