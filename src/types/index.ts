/**
 * Shared TypeScript interfaces and types used across the application.
 */

/** The structured result returned by the AI intent extraction service. */
export interface AIExtractionResult {
  type: "REMINDER" | "NOTE" | "TASK";
  content: string;
  dueAt: string | null;
}

/** Data payload stored in each BullMQ reminder job. */
export interface ReminderJobData {
  taskId: string;
  targetJid: string;
  message: string;
}
