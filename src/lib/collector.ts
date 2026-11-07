import { useState } from "react";
import { API_BASE } from "../api/client";
import { loadJson, saveJson } from "./storage";

// 노트북에서 백엔드를 켜는 명령(PowerShell)
export const SERVER_COMMAND = "cd C:\\wm\\watchmate-be; .\\.venv\\Scripts\\python -m uvicorn app.main:app --port 8000";

export const maskToken = (t: string) => `••••••${t.slice(-4)}`;

// 수집기(tools/collector.py live) 실행 명령. 토큰은 이 브라우저에만 있고, 화면에는 가려서 보여 준다.
export function collectorCommand(opts: {
  gateway: string;
  api: string;
  receivers: string[];
  tokens: Record<string, string>;
  masked: boolean;
}): string {
  return [
    ".\\.venv\\Scripts\\python tools\\collector.py live",
    `--gateway ${opts.gateway.trim() || "COM6"}`,
    `--api ${opts.api.trim() || API_BASE}`,
    ...opts.receivers.map((name) => {
      const t = opts.tokens[name];
      return `--port gw:${name} --token ${t ? (opts.masked ? maskToken(t) : t) : `<${name} 토큰>`}`;
    }),
  ].join(" ");
}

// 게이트웨이 포트와 수집기가 보낼 서버 주소. 이 브라우저에 기억한다.
export function useCollectorSettings() {
  const [gateway, setGatewayState] = useState<string>(() => loadJson("wm.gatewayPort", "COM6"));
  const [apiUrl, setApiUrlState] = useState<string>(() => loadJson("wm.collectorApi", API_BASE));
  return {
    gateway,
    apiUrl,
    setGateway: (v: string) => {
      setGatewayState(v);
      saveJson("wm.gatewayPort", v);
    },
    setApiUrl: (v: string) => {
      setApiUrlState(v);
      saveJson("wm.collectorApi", v);
    },
  };
}
