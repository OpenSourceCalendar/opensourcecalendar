import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

// WRANGLER_CONFIG picks another config file, e.g. the opensourcecalendar.com one (wrangler.production.toml,
// kept out of git). Unset, it's wrangler.toml, the template self-hosters fill in.
export default defineConfig({ plugins: [react(), cloudflare({ configPath: process.env.WRANGLER_CONFIG })] });
