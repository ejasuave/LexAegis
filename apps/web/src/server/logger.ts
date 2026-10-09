import 'server-only';

/**
 * Structured logger that accepts only allowlisted operational fields. There is no parameter
 * through which legal text, headers, cookies, credentials or key material could be passed.
 */
export interface LogFields {
  readonly event: string;
  readonly requestId?: string;
  readonly code?: string;
  readonly status?: number;
}

export type LogSink = (line: string) => void;

export function createLogger(sink: LogSink = (line) => console.log(line)) {
  const write = (level: 'info' | 'warn' | 'error', fields: LogFields) => {
    sink(
      JSON.stringify({
        level,
        event: fields.event,
        ...(fields.requestId !== undefined && { requestId: fields.requestId }),
        ...(fields.code !== undefined && { code: fields.code }),
        ...(fields.status !== undefined && { status: fields.status }),
      }),
    );
  };
  return {
    info: (fields: LogFields) => write('info', fields),
    warn: (fields: LogFields) => write('warn', fields),
    error: (fields: LogFields) => write('error', fields),
  };
}

export const logger = createLogger();
