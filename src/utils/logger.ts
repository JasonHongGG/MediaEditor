/**
 * Centralized Logger Module for MediaEditor App.
 * All console output should go through this module for consistent formatting and control.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_COLORS: Record<LogLevel, string> = {
  debug: 'color: #9ca3af',
  info:  'color: #facc15',
  warn:  'color: #f97316',
  error: 'color: #ef4444; font-weight: bold',
};

const PREFIX = '[MediaEditor]';

function formatTimestamp(): string {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function log(level: LogLevel, module: string, message: string, ...data: unknown[]) {
  const timestamp = formatTimestamp();
  const tag = `${PREFIX}[${module}][${level.toUpperCase()}]`;
  const style = LOG_COLORS[level];

  if (data.length > 0) {
    console[level === 'debug' ? 'log' : level](
      `%c${timestamp} ${tag} ${message}`,
      style,
      ...data
    );
  } else {
    console[level === 'debug' ? 'log' : level](
      `%c${timestamp} ${tag} ${message}`,
      style
    );
  }
}

/**
 * Creates a scoped logger instance for a specific module.
 * Usage:
 *   const log = createLogger('YoutubeDownloader');
 *   log.info('Starting download...');
 *   log.error('Download failed', errorObj);
 */
export function createLogger(module: string) {
  return {
    debug: (message: string, ...data: unknown[]) => log('debug', module, message, ...data),
    info:  (message: string, ...data: unknown[]) => log('info',  module, message, ...data),
    warn:  (message: string, ...data: unknown[]) => log('warn',  module, message, ...data),
    error: (message: string, ...data: unknown[]) => log('error', module, message, ...data),
  };
}

export type Logger = ReturnType<typeof createLogger>;
