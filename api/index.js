// Vercel entry point — Vercel's Node runtime accepts an Express app as the
// default export of a file under /api and wraps it as a serverless
// function. Everything else (routes, static file serving) is unchanged;
// see vercel.json for the rewrite that sends all paths here.
import app from '../server.js';

export default app;
