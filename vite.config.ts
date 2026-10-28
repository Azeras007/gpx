import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// Preact runs the React code through "preact/compat" (React's API in ~15 KB
// instead of ~400 KB for react-dom): the app starts much faster on phones.
export default defineConfig({
  plugins: [preact()],
  base: "./",
  build: {
    rollupOptions: {
      // index.html = marketing page, app.html = the route planner
      input: {
        main: "index.html",
        app: "app.html",
      },
    },
  },
});
