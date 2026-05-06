// Minimal structured logger. Witness has no opinion on log shipping;
// real consumers will replace this via setLogger. Default writes to
// stderr in JSON-ish format so witness doesn't pollute caller stdout.

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

class StderrLogger implements Logger {
  private write(level: string, msg: string, meta?: Record<string, unknown>): void {
    const line = JSON.stringify({ level, msg, ...meta, ts: new Date().toISOString() });
    // process.stderr.write is the only "console" call witness owns.
    process.stderr.write(`${line}\n`);
  }
  debug(msg: string, meta?: Record<string, unknown>): void {
    if (process.env.WITNESS_LOG_DEBUG === '1') this.write('debug', msg, meta);
  }
  info(msg: string, meta?: Record<string, unknown>): void {
    this.write('info', msg, meta);
  }
  warn(msg: string, meta?: Record<string, unknown>): void {
    this.write('warn', msg, meta);
  }
  error(msg: string, meta?: Record<string, unknown>): void {
    this.write('error', msg, meta);
  }
}

class SilentLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}

let active: Logger =
  process.env.NODE_ENV === 'test' || process.env.VITEST ? new SilentLogger() : new StderrLogger();

export const logger: Logger = {
  debug: (m, x) => active.debug(m, x),
  info: (m, x) => active.info(m, x),
  warn: (m, x) => active.warn(m, x),
  error: (m, x) => active.error(m, x),
};

export function setLogger(custom: Logger): void {
  active = custom;
}
