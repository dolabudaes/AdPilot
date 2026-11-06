type ApiErrorPayload = {
  message?: string;
  error?: string;
};

export async function fetchJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
  fallbackMessage = "Request failed"
): Promise<T> {
  const res = await fetch(input, init);
  const text = await res.text();
  let payload: unknown = null;

  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(res.ok ? "Response was not valid JSON" : fallbackMessage);
    }
  }

  if (!res.ok) {
    const errorPayload = payload as ApiErrorPayload | null;
    throw new Error(errorPayload?.message || errorPayload?.error || fallbackMessage);
  }

  if (!payload) {
    throw new Error("Empty response. Confirm the local service is running.");
  }

  return payload as T;
}
