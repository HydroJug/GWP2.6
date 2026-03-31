#!/usr/bin/env node
import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync, readdirSync, realpathSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, 'dist');
if (!existsSync(dist)) mkdirSync(dist);

// Entry point
const entry = join(__dirname, 'src', '_entry_build.js');
writeFileSync(entry, `
import __runFunction from '@shopify/shopify_function/run';
import { run as runCartLinesDiscountsGenerateRun } from './run.js';
export function cartLinesDiscountsGenerateRun() { return __runFunction(runCartLinesDiscountsGenerateRun); }
`);

// WIT file
const witDir = join(os.tmpdir(), 'buy-more-save-more-wit');
if (!existsSync(witDir)) mkdirSync(witDir);
const witPath = join(witDir, 'javy-world.wit');
writeFileSync(witPath, `package function:impl;

world shopify-function {
  export %cart-lines-discounts-generate-run: func();
}
`);

const esbuild = join(__dirname, 'node_modules', '.bin', 'esbuild');
const bundle  = join(dist, 'function.js');

// Locate javy and plugin from the Shopify CLI installation
function findCliBase() {
  try {
    const shopifyBin = execSync('which shopify', { encoding: 'utf8' }).trim();
    const realPath = realpathSync(shopifyBin);
    const directBin = dirname(realPath);
    if (readdirSync(directBin).some(f => f.startsWith('javy'))) return directBin;
    const libexec = dirname(dirname(realPath));
    return join(libexec, 'lib', 'node_modules', '@shopify', 'cli', 'bin');
  } catch {
    const npmRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return join(npmRoot, '@shopify', 'cli', 'bin');
  }
}

const cliBase = findCliBase();
const bins = readdirSync(cliBase);
const javyName = bins.filter(f => f.startsWith('javy-')).sort().pop();
const pluginName = bins.filter(f => /^shopify_functions_javy_v\d+\.wasm$/.test(f)).sort().pop();

if (!javyName) throw new Error(`No javy binary found in ${cliBase}`);
if (!pluginName) throw new Error(`No javy plugin found in ${cliBase}`);

const javy   = join(cliBase, javyName);
const plugin = join(cliBase, pluginName);

try {
  execSync(
    `${esbuild} ${entry} --bundle --format=esm --target=es2022 --outfile=${bundle}`,
    { stdio: 'inherit' }
  );
  execSync(
    `${javy} build ${bundle} -C dynamic -C plugin=${plugin} -C wit=${witPath} -C wit-world=shopify-function -o ${join(dist, 'function.wasm')}`,
    { stdio: 'inherit' }
  );
  console.log('Build successful');
} finally {
  try { rmSync(entry); } catch {}
  try { rmSync(witDir, { recursive: true }); } catch {}
}
