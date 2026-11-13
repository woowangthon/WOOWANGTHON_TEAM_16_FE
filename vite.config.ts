import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// 개발 중에는 /api 요청을 로컬 백엔드(uvicorn, 8000번)로 넘긴다. 배포에서는 VITE_API_BASE로 백엔드 주소를 준다.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "WATCHMATE_");
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      proxy: {
        "/api": { target: env.WATCHMATE_API || "http://127.0.0.1:8000", changeOrigin: true },
        // 녹화 도우미(scripts/record_live.py)가 알려 주는 지금 장면. 도우미가 꺼져 있으면 응답이 없다
        "/rec/": { target: `http://127.0.0.1:${env.WATCHMATE_REC_PORT || 8765}`, changeOrigin: true },
      },
    },
  };
});
