// Vercel entry point: every /api/* request is routed here (see vercel.json).
// The static pages in public/ are served by Vercel's CDN.
import { createApp } from '../server/app.js';

export default createApp();
