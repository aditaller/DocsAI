export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const severity: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  constructor(private readonly minimum: LogLevel) {}

  debug(event: string, fields: Record<string, unknown> = {}): void {
    this.write('debug', event, fields);
  }

  info(event: string, fields: Record<string, unknown> = {}): void {
    this.write('info', event, fields);
  }

  warn(event: string, fields: Record<string, unknown> = {}): void {
    this.write('warn', event, fields);
  }

  error(event: string, fields: Record<string, unknown> = {}): void {
    this.write('error', event, fields);
  }

  private write(level: LogLevel, event: string, fields: Record<string, unknown>): void {
    if (severity[level] < severity[this.minimum]) return;
    // Callers must provide IDs/counts only. OCR/source text is intentionally never logged.
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields }));
  }
}
