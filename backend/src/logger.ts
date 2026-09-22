/** Minimal structured logger: one JSON object per line, no dependencies. */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

type Fields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  child(fields: Fields): Logger;
}

const rank: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function serializeError(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

export function createLogger(level: LogLevel = 'info', base: Fields = {}, write: (line: string) => void = defaultWrite): Logger {
  const threshold = rank[level];
  const emit = (lvl: LogLevel, message: string, fields?: Fields) => {
    if (rank[lvl] < threshold) return;
    const record: Fields = { time: new Date().toISOString(), level: lvl, msg: message, ...base };
    if (fields) for (const [k, v] of Object.entries(fields)) record[k] = serializeError(v);
    write(JSON.stringify(record));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger(level, { ...base, ...fields }, write),
  };
}

function defaultWrite(line: string): void {
  process.stdout.write(line + '\n');
}

export const silentLogger: Logger = createLogger('silent');
