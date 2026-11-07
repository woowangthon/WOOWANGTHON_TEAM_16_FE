import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 개발 중에는 /api 요청을 로컬 백엔드(uvicorn, 8000번)로 넘긴다. 배포에서는 VITE_API_BASE로 백엔드 주소를 준다.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8000", changeOrigin: true },
    },
  },
});
