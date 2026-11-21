// Small fetch helpers. Module calls go through the manager's proxy: /api/modules/<name>/<path>.

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail = body && typeof body === "object" && "detail" in body ? body.detail : body;
    throw new ApiError(typeof detail === "string" ? detail : JSON.stringify(detail) || `${res.status} ${res.statusText}`, res.status);
  }
  return body as T;
}

export const mod = (name: string, path: string) => `/api/modules/${name}${path}`;

export const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

type FormValue = string | number | boolean | Blob | File[] | Blob[] | null | undefined;

export function form(fields: Record<string, FormValue>, fileField?: string): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value)) value.forEach((v) => fd.append(fileField ?? key, v));
    else if (value instanceof Blob) fd.append(key, value);
    else fd.append(key, String(value));
  }
  return fd;
}

export const post = (body: FormData): RequestInit => ({ method: "POST", body });

export const pct = (v: number | null | undefined, digits = 0) => (v === null || v === undefined ? "–" : `${(v * 100).toFixed(digits)}%`);
export const num = (v: number | null | undefined, digits = 2) => (v === null || v === undefined || Number.isNaN(v) ? "–" : v.toFixed(digits));
