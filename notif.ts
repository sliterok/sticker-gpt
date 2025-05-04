import "dotenv/config";
import { Telegraf, Input, TelegramError } from "telegraf";
import fs from "fs/promises";
import path from "path";
import { type } from "os";
import {
  IGeneration,
  IPayload,
  IResponse,
  TaskStatus,
  TaskType,
} from "./types";
import { cropFeatheredStickers } from "./cv";
import headers from "./headers.json";

// --- Constants ---
const LAST_ID_FILE_PATH = path.join(__dirname, "last.json"); // Use __dirname for robustness
const API_BASE_URL = "https://sora.com/backend/notif";
const FETCH_LIMIT = 100;
const MIN_FETCH_INTERVAL_SECONDS = 5;
const DEFAULT_INTERVALS = {
  QUEUED: 15,
  RUNNING: 10,
  RECENT_GENERATION: 25, // < 2 mins
  MEDIUM_TERM_GENERATION: 50, // < 5 mins
  LONG_TERM_GENERATION: 120, // < 30 mins
  IDLE: 600, // > 30 mins
};

// --- Interfaces ---
interface IGetMessageOptions {
  linkUrl?: string;
  linkText?: string;
  suffix?: string;
}

// --- Notificator Class ---
class Notificator {
  private bot: Telegraf;
  private lastId?: string;
  private lastGenerationTime?: number;
  private status?: TaskStatus;
  private progress?: number;
  private progressMessageId?: number;
  private isFetching = false;
  private fetchTimeoutId?: NodeJS.Timeout;
  private readonly chatId: string;

  constructor() {
    const botToken = process.env.BOT_TOKEN;
    this.chatId = process.env.CHAT_ID!; // Already validated

    if (!botToken) {
      console.error("BOT_TOKEN environment variable is missing!");
      process.exit(1);
    }
    this.bot = new Telegraf(botToken);

    this.initialize();
  }

  private async initialize(): Promise<void> {
    await this.readLastId();
    this.fetchAndProcessNotifications();
    this.setupShutdownHandlers();
  }

  // --- State Management ---

  private async readLastId(): Promise<void> {
    try {
      const file = await fs.readFile(LAST_ID_FILE_PATH, "utf8");
      const data = JSON.parse(file);
      this.lastId = typeof data === "string" ? data : undefined;
      console.log(`Read lastId: ${this.lastId ?? "None"}`);
    } catch (error: any) {
      if (error.code === "ENOENT") {
        console.log(`${LAST_ID_FILE_PATH} not found, starting fresh.`);
      } else {
        console.warn(
          `Could not read or parse ${LAST_ID_FILE_PATH}, starting fresh. Error: ${error.message}`
        );
      }
      this.lastId = undefined;
    }
  }

  private async setLastId(id: string): Promise<void> {
    if (id === this.lastId) return; // Avoid unnecessary writes
    try {
      await fs.writeFile(LAST_ID_FILE_PATH, JSON.stringify(id), "utf8");
      this.lastId = id;
      console.log(`Persisted new lastId: ${id}`);
    } catch (error) {
      console.error(`Failed to write ${LAST_ID_FILE_PATH}:`, error);
      // Consider retry logic or alternative handling if persistence is critical
    }
  }

  // --- Fetching Logic ---

  private scheduleNextFetch(): void {
    if (this.fetchTimeoutId) {
      clearTimeout(this.fetchTimeoutId); // Clear existing timeout
    }
    if (this.isFetching) return; // Don't schedule if already fetching

    const intervalSeconds = this.getNextInterval();
    console.log(`Scheduling next fetch in ${intervalSeconds} seconds.`);
    this.fetchTimeoutId = setTimeout(
      () => this.fetchAndProcessNotifications(),
      intervalSeconds * 1000
    );
  }

  private getNextInterval(): number {
    let interval: number;

    switch (this.status) {
      case TaskStatus.queued:
        interval = DEFAULT_INTERVALS.QUEUED;
        break;
      case TaskStatus.running:
        interval = DEFAULT_INTERVALS.RUNNING;
        break;
      default: // succeeded, failed, or undefined
        interval = this.getIdleInterval();
    }
    // Optional: Add jitter
    // interval += Math.random() * 2 - 1; // +/- 1 second
    return Math.max(MIN_FETCH_INTERVAL_SECONDS, interval);
  }

  private getIdleInterval(): number {
    const secondsSinceLastGen = this.lastGenerationTime
      ? (Date.now() - this.lastGenerationTime) / 1000
      : Infinity;

    if (secondsSinceLastGen < 120) return DEFAULT_INTERVALS.RECENT_GENERATION;
    if (secondsSinceLastGen < 300)
      return DEFAULT_INTERVALS.MEDIUM_TERM_GENERATION;
    if (secondsSinceLastGen < 1800)
      return DEFAULT_INTERVALS.LONG_TERM_GENERATION;
    return DEFAULT_INTERVALS.IDLE;
  }

  private async fetchAndProcessNotifications(): Promise<void> {
    if (this.isFetching) {
      console.log("Fetch already in progress, skipping.");
      return;
    }
    this.isFetching = true;
    console.log(`Fetching notifications... (using lastId: ${this.lastId})`);

    try {
      const response = await this.fetchNotifications();
      if (!response) return; // Error handled in fetchNotifications

      if (!this.isValidResponse(response)) {
        console.warn("Received invalid response structure:", response);
        return;
      }

      if (response.data.length === 0) {
        console.log("No new notifications found.");
        // Handle potential progress update even with no new *items*
        // Check if the API's last_id matches our current one and has progress info
        // This scenario seems less likely with the current API structure, but good to consider
        // await this.handlePotentialProgressWithoutNewItems(response);
        return;
      }

      console.log(
        `Processing ${response.data.length} new notifications. API's last_id: ${response.last_id}`
      );
      await this.processNotifications(response);

      // Update status and handle progress based on the *absolute latest* item from the API
      const absoluteLatestPayload = response.data[0]?.payload; // API returns newest first
      if (absoluteLatestPayload) {
        await this.handleProgressUpdate(absoluteLatestPayload);
      } else {
        // If somehow data exists but payload doesn't, clear progress
        await this.clearProgressMessageIfNeeded(undefined);
      }
    } catch (error) {
      console.error("Error during notification fetch/processing:", error);
      // Consider more specific error handling (e.g., network vs. processing errors)
    } finally {
      this.isFetching = false;
      this.scheduleNextFetch(); // Always schedule the next attempt
    }
  }

  private async fetchNotifications(): Promise<IResponse | null> {
    const params = new URLSearchParams({ limit: String(FETCH_LIMIT) });
    if (this.lastId) {
      params.append("before", this.lastId);
    }

    const apiUrl = `${API_BASE_URL}?${params.toString()}`;
    console.log(`Requesting URL: ${apiUrl}`);

    try {
      const req = await fetch(apiUrl, { headers });

      if (!req.ok) {
        const errorBody = await req
          .text()
          .catch(() => "Could not read error body");
        console.error(
          `API request failed: ${req.status} ${req.statusText}. URL: ${apiUrl}. Body: ${errorBody}`
        );
        return null; // Indicate failure
      }

      return (await req.json()) as IResponse;
    } catch (networkError) {
      console.error(`Network error fetching notifications: ${networkError}`);
      return null; // Indicate failure
    }
  }

  private isValidResponse(res: any): res is IResponse {
    return (
      res &&
      typeof res === "object" &&
      Array.isArray(res.data) &&
      (typeof res.last_id === "string" || res.last_id === null) // Allow null last_id
    );
  }

  // --- Processing Logic ---

  private async processNotifications(response: IResponse): Promise<void> {
    // Process notifications in reverse order (oldest new first)
    const notificationsToProcess = response.data.slice().reverse();
    let latestSuccessfullyProcessedId = this.lastId; // Start with current

    for (const item of notificationsToProcess) {
      const payload = item.payload;
      if (!payload) {
        console.warn("Notification item missing payload:", item);
        continue; // Skip this item
      }

      console.log(
        `Processing notification ID: ${payload.id}, Status: ${payload.status}`
      );

      if (payload.status === TaskStatus.succeeded) {
        const success = await this.handleSucceededTask(payload);
        if (success) {
          latestSuccessfullyProcessedId = payload.id;
          this.lastGenerationTime = Date.now(); // Update time on successful processing
          console.log(
            `Successfully processed notification for ${payload.id}. Updated latestSuccessfullyProcessedId to ${latestSuccessfullyProcessedId}.`
          );
          // Clear progress after successful send
          await this.clearProgressMessageIfNeeded(payload.status);
        } else {
          // If sending failed, stop processing this batch to avoid skipping
          console.log(
            `Stopping processing for this batch due to send error for ${payload.id}. lastId remains ${this.lastId}.`
          );
          return; // Exit processing loop
        }
      } else {
        console.log(
          `Task ${payload.id} status is ${payload.status}. Skipping send notification.`
        );
        // We still might need to update progress based on this later
      }
    } // End of loop

    // Persist the latest successfully processed ID *after* the loop
    if (
      latestSuccessfullyProcessedId &&
      latestSuccessfullyProcessedId !== this.lastId
    ) {
      await this.setLastId(latestSuccessfullyProcessedId);
    }
  }

  private async handleSucceededTask(payload: IPayload): Promise<boolean> {
    console.log(
      `Task ${payload.id} succeeded. Attempting to send notification...`
    );
    try {
      if (payload.type === TaskType.imageGen && payload.generations?.length) {
        await this.sendStickers(payload.generations);
      } else if (
        payload.type === TaskType.videoGen &&
        payload.generations?.length
      ) {
        await this.sendVideos(payload);
      } else {
        console.log(
          `Task ${payload.id} succeeded but type is ${payload.type} or no generations found. Skipping send.`
        );
      }
      return true; // Indicate success (or skipped appropriately)
    } catch (sendError) {
      console.error(
        `Failed to send notification for ${payload.id}:`,
        sendError
      );
      return false; // Indicate failure
    }
  }

  // --- Sending Logic ---

  /**
   * Sends a Telegram API request with automatic retry logic for rate limiting (429 errors).
   * @param method The Telegraf API method to call (e.g., this.bot.telegram.sendSticker).
   * @param args The arguments to pass to the API method.
   * @param context A description for logging purposes (e.g., "sticker for gen X").
   * @returns The result of the API call if successful.
   * @throws Throws an error if the request fails after all retries or for non-rate-limit reasons.
   */
  private async sendWithRetry<T extends (...args: any[]) => Promise<any>>(
    method: T,
    args: Parameters<T>,
    context: string
  ): Promise<Awaited<ReturnType<T>>> {
    const MAX_RETRIES = 5;
    let retries = 0;

    while (retries < MAX_RETRIES) {
      try {
        // Bind the method to the correct context (this.bot.telegram)
        const boundMethod = method.bind(this.bot.telegram);
        return await boundMethod(...args);
      } catch (err) {
        if (
          err instanceof TelegramError &&
          err.response?.error_code === 429 &&
          err.response.parameters?.retry_after
        ) {
          const retryAfter = err.response.parameters.retry_after;
          const waitMs = (retryAfter + 1) * 1000; // Add 1 second buffer
          retries++;
          console.warn(
            `Rate limit hit (429) sending ${context}. Retry ${retries}/${MAX_RETRIES} after ${
              waitMs / 1000
            }s.`
          );
          if (retries >= MAX_RETRIES) {
            console.error(`Max retries reached for ${context}. Giving up.`);
            throw new Error(
              `Failed to send ${context} after ${MAX_RETRIES} retries due to rate limiting.`
            );
          }
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        } else {
          // Handle other errors (network, invalid arguments, etc.)
          console.error(`Error sending ${context}:`, err);
          throw err; // Re-throw other errors immediately
        }
      }
    }
    // This part should theoretically not be reached if MAX_RETRIES > 0
    throw new Error(`Failed to send ${context} after exhausting retries.`);
  }

  private async sendStickers(generations: IGeneration[]): Promise<void> {
    for (const gen of generations) {
      if (!gen.encodings?.source?.path) {
        console.warn(
          `Skipping sticker for generation ${gen.id}: Missing source path.`
        );
        continue;
      }

      let imageBuffers: Buffer[] | null = null;
      try {
        imageBuffers = await cropFeatheredStickers(gen.encodings.source.path);
      } catch (cropError) {
        console.error(
          `Error cropping sticker for generation ${gen.id} from path ${gen.encodings.source.path}:`,
          cropError
        );
        continue; // Skip this generation if cropping fails
      }

      if (!imageBuffers || imageBuffers.length === 0) {
        console.warn(
          `No stickers generated from source path: ${gen.encodings.source.path}`
        );
        continue;
      }

      for (const source of imageBuffers) {
        try {
          await this.sendWithRetry(
            this.bot.telegram.sendSticker,
            [this.chatId, { source }],
            `sticker for gen ${gen.id}`
          );
        } catch (sendError) {
          console.error(
            `Failed to send sticker for gen ${gen.id} after retries: ${sendError}`
          );
          // Decide if one failure should stop all stickers for this generation
          // break; // Uncomment to stop processing stickers for the current generation on failure
        }
      } // end for loop (stickers)
    } // end for loop (generations)
  }

  private async sendVideos(payload: IPayload): Promise<void> {
    const mediaGroup = (payload.generations ?? [])
      .map((gen) => {
        if (gen.url) {
          return {
            type: "video" as const,
            media: {
              url: gen.url,
              filename: `${gen.title || payload.title || payload.id}.mp4`,
            },
            // Caption removed as per previous request
          };
        }
        console.warn(`Missing video URL for generation in task ${payload.id}`);
        return null;
      })
      .filter((item): item is NonNullable<typeof item> => item !== null); // Type guard

    if (mediaGroup.length === 0) {
      console.warn(`No valid video URLs found to send for task ${payload.id}`);
      return;
    }

    console.log(
      `Attempting to send ${mediaGroup.length} videos for task ${payload.id}`
    );
    // TODO: Implement splitting into multiple groups if mediaGroup.length > 10

    try {
      await this.sendWithRetry(
        this.bot.telegram.sendMediaGroup,
        [this.chatId, mediaGroup],
        `video group for task ${payload.id}`
      );
      console.log(`Successfully sent video group for task ${payload.id}`);
    } catch (sendError) {
      console.error(
        `Failed to send video group for task ${payload.id} after retries: ${sendError}`
      );
      // Decide if this failure should prevent the lastId from updating
      // Throwing an error here will propagate up and cause handleSucceededTask to return false
      throw sendError;
    }
  }

  // --- Progress Handling ---

  private async handleProgressUpdate(payload: IPayload): Promise<void> {
    this.status = payload.status; // Update overall status

    if (
      this.status === TaskStatus.running &&
      payload.progress_pct != null // Check for null/undefined
    ) {
      const progress = Math.round(payload.progress_pct * 100);

      // Only update if progress changed significantly or message doesn't exist
      if (
        !this.progressMessageId ||
        !this.progress ||
        Math.abs(this.progress - progress) >= 1 // Update if changed by >= 1%
      ) {
        this.progress = progress;
        const text = this.getMessage(payload, { suffix: `${progress}%` });
        console.log(`Updating progress for ${payload.id}: ${progress}%`);

        if (this.progressMessageId) {
          await this.editProgressMessage(text);
        } else {
          await this.sendNewProgressMessage(text);
        }
      }
    } else {
      // If the status is NOT running, clear the progress message.
      await this.clearProgressMessageIfNeeded(this.status);
    }
  }

  private async editProgressMessage(text: string): Promise<void> {
    if (!this.progressMessageId) return;
    try {
      await this.bot.telegram.editMessageText(
        this.chatId,
        this.progressMessageId,
        undefined, // inline_message_id
        text,
        { parse_mode: "HTML" }
      );
    } catch (editError: any) {
      if (
        editError.response?.error_code === 400 &&
        (editError.description?.includes("message to edit not found") ||
          editError.description?.includes("message is not modified"))
      ) {
        console.warn(
          `Failed to edit progress message (not found or not modified), sending new one. Error: ${editError.description}`
        );
        delete this.progressMessageId; // Reset ID
        await this.sendNewProgressMessage(text); // Send fresh
      } else {
        console.error("Failed to edit progress message:", editError);
        // Consider deleting the message ID if edit fails persistently?
        // delete this.progressMessageId;
      }
    }
  }

  private async sendNewProgressMessage(text: string): Promise<void> {
    try {
      const message = await this.bot.telegram.sendMessage(this.chatId, text, {
        parse_mode: "HTML",
        disable_notification: true, // Keep progress updates silent
      });
      this.progressMessageId = message.message_id;
      console.log(`Sent new progress message (ID: ${this.progressMessageId})`);
    } catch (sendError) {
      console.error("Failed to send new progress message:", sendError);
      // Reset progress state if sending fails
      delete this.progressMessageId;
      delete this.progress;
    }
  }

  private async clearProgressMessageIfNeeded(
    currentStatus?: TaskStatus
  ): Promise<void> {
    // Clear if message exists AND status is terminal (succeeded, failed) or undefined
    const isTerminalStatus =
      currentStatus &&
      currentStatus !== TaskStatus.running &&
      currentStatus !== TaskStatus.queued;

    if (this.progressMessageId && (isTerminalStatus || !currentStatus)) {
      console.log(
        `Task status is ${
          currentStatus || "finished/undefined"
        }. Deleting progress message (ID: ${this.progressMessageId}).`
      );
      try {
        await this.bot.telegram.deleteMessage(
          this.chatId,
          this.progressMessageId
        );
      } catch (deleteError: any) {
        if (
          !(
            deleteError.response?.error_code === 400 &&
            deleteError.description?.includes("message to delete not found")
          )
        ) {
          console.error("Failed to delete progress message:", deleteError);
        }
      } finally {
        // Always clear local state after attempting deletion
        delete this.progressMessageId;
        delete this.progress;
      }
    } else if (!this.progressMessageId) {
      // Ensure progress state is clear if no message ID exists
      delete this.progress;
    }
  }

  // --- Helpers ---

  private getMessage(payload: IPayload, opts: IGetMessageOptions): string {
    const baseUrl = `https://sora.com/t/${payload.id}`;
    const url = opts.linkUrl || baseUrl;
    const linkText = opts?.linkText || payload.title || `Task ${payload.id}`;
    // Basic HTML escaping for link text
    const escapedLinkText = linkText
      .replace(/&/g, "&")
      .replace(/</g, "<")
      .replace(/>/g, ">");

    const link = `<a href="${url}">${escapedLinkText}</a>`;
    return opts.suffix ? `${link} ${opts.suffix}` : link;
  }

  // --- Lifecycle ---

  private setupShutdownHandlers(): void {
    const shutdown = (signal: string) => {
      console.log(`Received ${signal}. Shutting down gracefully...`);
      if (this.fetchTimeoutId) {
        clearTimeout(this.fetchTimeoutId);
      }
      // Add any other cleanup logic here (e.g., close DB connections)
      console.log("Shutdown complete.");
      process.exit(0);
    };

    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  }
}

// --- Initialization ---

function validateEnvVariables(): boolean {
  const requiredEnvVars = ["BOT_TOKEN", "CHAT_ID"];
  const missingEnvVars = requiredEnvVars.filter(
    (varName) => !process.env[varName]
  );

  if (missingEnvVars.length > 0) {
    console.error(
      `Missing required environment variables: ${missingEnvVars.join(
        ", "
      )}. Exiting.`
    );
    return false;
  }
  return true;
}

if (validateEnvVariables()) {
  console.log("Starting Sora Notificator...");
  new Notificator();
} else {
  process.exit(1);
}
