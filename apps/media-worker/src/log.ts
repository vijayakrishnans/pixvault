// Structured log lines for Workers Logs. Ids, sizes and timings only: never file contents, file names, URLs,
// tokens or emails (a URL or long hex string in an error message is redacted).

const REDACT = [/https?:\/\/\S+/g, /\b[0-9a-f]{40,}\b/gi, /[^\s@]+@[^\s@]+\.[^\s@]+/g];

function clean(text: unknown): string {
  let s = String(text ?? "").slice(0, 300);
  for (const re of REDACT) s = s.replace(re, "[redacted]");
  return s;
}

/** "/v1/organizations/org_ab12…/libraries/lib_…/uploads/ups_…/commit" → "/v1/organizations/:id/libraries/:id/uploads/:id/commit" */
export function routeTemplate(path: string): string {
  return path.replace(/\/[a-z]{2,4}_[0-9a-f]{32}(?=\/|$)/g, "/:id").replace(/\/usr_[A-Za-z0-9_-]+/g, "/:id").replace(/\/parts\/\d+/, "/parts/:n");
}

type Field = string | number | boolean | null | undefined;

export function logError(requestId: string, where: string, err: unknown, fields: Record<string, Field> = {}): void {
  const e = err as { name?: unknown; message?: unknown; code?: unknown };
  console.error(
    JSON.stringify({
      level: "error",
      msg: "media_error",
      where,
      requestId,
      name: clean(e?.name ?? typeof err),
      message: clean(e?.message ?? err),
      ...(e?.code !== undefined ? { code: clean(e.code) } : {}),
      ...fields,
    }),
  );
}

export function logInfo(requestId: string, msg: string, fields: Record<string, Field> = {}): void {
  // eslint-disable-next-line no-console -- structured info line for Workers Logs (ids and sizes only)
  console.log(JSON.stringify({ level: "info", msg, requestId, ...fields }));
}
