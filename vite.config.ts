import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
