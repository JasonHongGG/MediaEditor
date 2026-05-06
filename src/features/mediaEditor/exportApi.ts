import { emitTo } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { PendingExportSession, TimelineExportRequest } from './exportTypes';
import { createLogger, getErrorMessage, serializeError } from '../../utils/logger';

const EXPORT_WINDOW_LABEL = 'export';
const EXPORT_WINDOW_URL = 'index.html?view=export';
const log = createLogger('ExportWindowApi');

export function setPendingExportSession(session: PendingExportSession) {
  return invoke<void>('set_pending_export_session', { session });
}

export function getPendingExportSession() {
  return invoke<PendingExportSession | null>('get_pending_export_session');
}

export function processTimelineExport(request: TimelineExportRequest) {
  return invoke<void>('process_timeline_export', { request });
}

function waitForWindowCreation(exportWindow: WebviewWindow) {
  return new Promise<WebviewWindow>((resolve, reject) => {
    let settled = false;
    let createdCleanup: (() => void) | undefined;
    let errorCleanup: (() => void) | undefined;
    const timeoutId = window.setTimeout(() => {
      settleReject(new Error('Timed out while creating the export window.'));
    }, 4000);

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      createdCleanup?.();
      errorCleanup?.();
    };

    const settleResolve = () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(exportWindow);
    };

    const settleReject = (error: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(getErrorMessage(error, 'Failed to create export window.')));
    };

    void exportWindow.once('tauri://created', () => {
      log.info('Export window created successfully.');
      settleResolve();
    }).then((unlisten) => {
      createdCleanup = unlisten;
    }).catch((error) => {
      settleReject(error);
    });

    void exportWindow.once<string>('tauri://error', (event) => {
      const error = new Error(getErrorMessage(event.payload, 'Failed to create export window.'));
      log.error('Export window creation failed.', {
        event: serializeError(event.payload),
      });
      settleReject(error);
    }).then((unlisten) => {
      errorCleanup = unlisten;
    }).catch((error) => {
      settleReject(error);
    });
  });
}

export async function openExportWindow(session: PendingExportSession) {
  log.info('Opening export window.', {
    projectName: session.projectName,
    clipCount: session.clips.length,
    trackCount: session.tracks.length,
  });

  await setPendingExportSession(session);

  const existingWindow = await WebviewWindow.getByLabel(EXPORT_WINDOW_LABEL);
  if (existingWindow) {
    await emitTo(EXPORT_WINDOW_LABEL, 'editor/export-session-updated', session).catch((error) => {
      log.warn('Failed to push updated session to an existing export window.', serializeError(error));
    });
    await existingWindow.setFocus().catch((error) => {
      log.warn('Failed to focus existing export window.', serializeError(error));
    });
    return existingWindow;
  }

  const exportWindow = new WebviewWindow(EXPORT_WINDOW_LABEL, {
    url: EXPORT_WINDOW_URL,
    title: 'Export Settings',
    width: 800,
    height: 720,
    minWidth: 700,
    minHeight: 680,
    center: true,
    resizable: true,
    focus: true,
    decorations: false,
    transparent: true,
  });

  return waitForWindowCreation(exportWindow);
}