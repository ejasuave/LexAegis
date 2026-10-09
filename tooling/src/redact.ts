/** Removes credential-bearing material before anything is printed or recorded. */
export function redact(text: string): string {
  return text
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]*@/gi, '$1[redacted]@')
    .replace(
      /(https?:\/\/[^\s/?#]+)(\/[^\s?#]*)?(\?[^\s#]*)?/gi,
      (
        match: string,
        origin: string,
        path: string | undefined = '',
        query: string | undefined = '',
      ) => {
        const sensitive =
          /\/(v\d+|api|rpc|key|token)\/[A-Za-z0-9_-]{16,}/i.test(path) || query !== '';
        return sensitive ? `${origin}/[redacted]` : match;
      },
    )
    .replace(/\b(authorization|x-api-key|api-key)\s*:\s*[^\r\n]+/gi, '$1: [redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [redacted]')
    .replace(
      /\b([A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|SESSION_SECRET)[A-Z0-9_]*)\s*[=:]\s*\S+/g,
      '$1=[redacted]',
    )
    .replace(/\bsk-[A-Za-z0-9]{16,}\b/g, '[redacted]');
}
