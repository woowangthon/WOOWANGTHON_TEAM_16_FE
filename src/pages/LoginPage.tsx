import { Wifi } from "lucide-react";
import { useState, type FormEvent } from "react";
import { API_LABEL, ApiError, IS_DEPLOYED } from "../api/client";
import { Button } from "../components/ui";
import { useSession } from "../state/session";

export default function LoginPage() {
  const { login, enterMock, expired } = useSession();
  const [username, setUsername] = useState("demo");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError("아이디와 비밀번호를 입력하세요.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await login(username.trim(), password);
    } catch (err) {
      if (err instanceof ApiError && err.status === 0 && IS_DEPLOYED) {
        setError("서버를 깨우는 중이에요. 무료 서버라 1분쯤 걸릴 수 있으니 잠시 뒤 다시 눌러 주세요.");
      } else {
        setError(err instanceof ApiError ? err.message : "로그인하지 못했습니다.");
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center bg-page px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-xl bg-brand text-white">
            <Wifi size={24} strokeWidth={2.4} />
          </span>
          <div>
            <h1 className="text-xl font-bold text-slate-900">와치메이트</h1>
            <p className="text-sm text-slate-500">Wi-Fi 기척 실험 화면</p>
          </div>
        </div>
        {expired ? (
          <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            로그인이 끝났어요. 서버를 다시 켜면 다시 로그인해야 해요. 실험 기록은 이 브라우저에 그대로 있어요.
          </p>
        ) : null}
        <form onSubmit={submit} className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6">
          <label className="block text-sm font-medium text-slate-700">
            아이디
            <input
              id="login-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            비밀번호
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2"
            />
          </label>
          {error ? <p className="text-sm text-red-700">{error}</p> : null}
          <Button type="submit" variant="primary" className="w-full" disabled={pending}>
            {pending ? "로그인 중" : "로그인"}
          </Button>
          <p className="text-xs leading-relaxed text-slate-500">
            {import.meta.env.DEV ? (
              <>
                테스트 계정은 백엔드 <code>.env</code>의 DEMO_USERNAME·DEMO_PASSWORD예요(설정 안 했으면 demo / demo1234).{" "}
              </>
            ) : (
              "테스트 계정으로 로그인하면 첫 화면에서 실제 측정 녹화를 바로 재생해 볼 수 있어요. "
            )}
            연결 대상: {API_LABEL}
          </p>
        </form>
        <button type="button" onClick={enterMock} className="mt-4 w-full text-center text-sm text-slate-500 underline hover:text-slate-800">
          서버 없이 UI 예시(가상 데이터)로 보기
        </button>
        <p className="mt-1 text-center text-xs leading-relaxed text-slate-500">
          UI 예시는 화면 모양만 보여 주는 가상 데이터예요. 실제 판정 결과가 아니에요.
        </p>
      </div>
    </div>
  );
}
