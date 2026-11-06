/**
 * HTTP business APIs live on FastAPI.
 * Browser calls stay on same-origin `/api/*` via the catch-all route
 * `app/api/[...path]/route.ts` (more reliable than external rewrites in this monorepo).
 *
 * Env: single source of truth is repo-root `.env.local` (not `apps/web/.env.local`).
 */
const path = require("path");
const { loadEnvConfig } = require("@next/env");

const repoRoot = path.join(__dirname, "../..");
loadEnvConfig(repoRoot);

/** @type {import('next').NextConfig} */
const nextConfig = {};

module.exports = nextConfig;
