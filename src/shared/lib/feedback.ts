export type NoticeTone = 'success' | 'error' | 'warning' | 'info';

export interface NoticeInput {
  tone: NoticeTone;
  message: string;
}

export function publicFailureMessage(action: string): string {
  return `${action}失败，请稍后重试。`;
}

export function errorCategory(error: unknown): string {
  if (error instanceof Error) return error.name || 'Error';
  if (error === null) return 'null';
  return typeof error;
}

export function reportOperationFailure(scope: string, error: unknown): void {
  console.error(`[${scope}] operation failed`, { errorCategory: errorCategory(error) });
}
