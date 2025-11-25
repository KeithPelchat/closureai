// public/js/closureApi.js

async function apiFetch(path, options = {}) {
  const res = await fetch(path, {
    credentials: "include", // send the closureai_auth cookie
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
    body:
      options.body !== undefined
        ? JSON.stringify(options.body)
        : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch (_) {}

  if (!res.ok) {
    const message = (data && data.error) || `Request failed: ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

export async function getCurrentUser() {
  return apiFetch("/api/me");
}

export async function listSessions(limit = 20) {
  const params = new URLSearchParams({ limit: String(limit) });
  return apiFetch(`/api/sessions?${params.toString()}`);
}

export async function createSession({ inputPrompt, rawOutput, cleanedOutput }) {
  return apiFetch("/api/sessions", {
    method: "POST",
    body: { inputPrompt, rawOutput, cleanedOutput },
  });
}