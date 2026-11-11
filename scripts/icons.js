// Renders public/icons/icon.svg to the PNG sizes the web app manifest needs.
// Usage: npm run icons
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const svg = await readFile('public/icons/icon.svg', 'utf8');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();

async function render(size, file, { maskable = false } = {}) {
  await page.setViewportSize({ width: size, height: size });
  // Maskable icons need the artwork inside the central 80% "safe zone".
  const inner = maskable
    ? `<div style="width:100%;height:100%;background:#4262ff;display:grid;place-items:center">
         <div style="width:80%;height:80%">${svg}</div></div>`
    : svg;
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:100%;height:100%;display:block}</style>${inner}`);
  await page.screenshot({ path: `public/icons/${file}`, omitBackground: !maskable });
}

await render(192, 'icon-192.png');
await render(512, 'icon-512.png');
await render(512, 'icon-maskable-512.png', { maskable: true });
await render(180, 'apple-touch-icon.png');
await browser.close();
console.log('Icons written to public/icons/');
