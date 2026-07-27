import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// フロントエンドのビルド設定。
// dev では server/index.ts が Vite を middleware モードで取り込むため、この設定は
// build 時とミドルウェア生成時の共通設定として使われる(Corstack と同じ構造)。
export default defineConfig({
  root: ".",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
