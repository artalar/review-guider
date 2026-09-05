import type { SessionToken } from '../git/journal'

export const RECOVERY_RESTORE = 'Restore now'
export const RECOVERY_LATER = 'Later'
export const RECOVERY_DISMISS = 'Dismiss reminder'

export function describeRecoveryPrompt(token: SessionToken): { message: string, detail: string } {
  return {
    message: 'Tabthrough did not finish restoring your work last time.',
    detail: [
      `Session ${token.sessionId} stopped at stage "${token.stage}". Nothing was discarded.`,
      'Later keeps Start blocked until you Restore or Dismiss. Dismiss reminder forgets only the reminder — stash entry and backup refs stay in git until you clean them up.',
    ].join('\n\n'),
  }
}
