// 브라우저 저장소. 사생활 보호 모드처럼 저장소를 못 쓰는 경우에도 화면은 돌아가야 하므로 실패는 무시한다.

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 저장소가 가득 찼거나 막혀 있으면 이번 값만 잃는다
  }
}

export function removeKey(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 무시
  }
}
