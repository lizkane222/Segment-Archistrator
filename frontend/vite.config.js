import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Two things worth knowing here.
//
// 1. `base` differs by command. The production build lands in ../static/spa,
//    which Django serves through WhiteNoise under /static/, so built asset URLs
//    must be prefixed. The dev server serves from the root instead -- setting
//    base in dev would push the app to localhost:5177/static/ for no gain.
//
// 2. The dev proxy is load-bearing, not a convenience. The session cookie is
//    httpOnly and SameSite=Lax, so it only travels if the browser believes the
//    API is same-origin. Pointing fetch() at http://localhost:8000 directly
//    would silently drop it and every request would look logged out.
//
// 3. The proxy target's port is a variable because Django is not always on 8000 --
//    `runserver 8010` is a normal thing to do, and with the port hardcoded the dev
//    server proxies to nothing, every request 502s, and the only way to see a
//    frontend change is a full `npm run build`. Set API_PORT to match whatever
//    runserver was given.
const API_PORT = process.env.API_PORT ?? '8000'

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  base: command === 'build' ? '/static/' : '/',
  build: {
    outDir: '../static/spa',
    emptyOutDir: true,
  },
  server: {
    port: 5177,
    proxy: {
      '/api': { target: `http://127.0.0.1:${API_PORT}` },
    },
  },
}))
