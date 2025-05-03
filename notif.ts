import "dotenv/config";
import {
  IGeneration,
  IPayload,
  IResponse,
  TaskStatus,
  TaskType,
} from "./types";
import { Telegraf } from "telegraf";
import fs from "fs/promises";
import { headers } from "./fetch";
import { cropFeatheredStickers } from "./cv";

class Notificator {
  private lastGenerationTime?: number;
  private lastId?: string; // Initialize as potentially undefined
  private status?: TaskStatus; // Initialize as potentially undefined
  private progressMessageId?: number;
  private progress?: number;
  private bot = new Telegraf(process.env.BOT_TOKEN!);
  private isFetching = false; // Prevent concurrent fetches

  constructor() {
    this.readLastId().then(() => {
      this.getNotifications();
    });
  }

  private async readLastId() {
    try {
      // Use a constant for the filename
      const filePath = "./last.json";
      const file = await fs.readFile(filePath, "utf8");
      const data = JSON.parse(file);
      // Ensure lastId is a string or undefined
      this.lastId = typeof data === "string" ? data : undefined;
      console.log(`Read lastId: ${this.lastId}`);
    } catch (error: any) {
      // If file doesn't exist (ENOENT), it's okay, just start fresh.
      if (error.code === "ENOENT") {
        console.log("last.json not found, starting fresh.");
        this.lastId = undefined;
      } else {
        // For other errors (parsing, permissions), log a warning.
        console.warn(
          "Could not read or parse last.json, starting fresh.",
          error
        );
        this.lastId = undefined;
      }
    }
  }

  private async setLastId(id: string) {
    try {
      // Use a constant for the filename
      const filePath = "./last.json";
      await fs.writeFile(filePath, JSON.stringify(id), "utf8");
      this.lastId = id;
      console.log(`Persisted new lastId: ${id}`);
    } catch (error) {
      console.error("Failed to write last.json:", error);
      // Decide if we should retry or handle this failure case
    }
  }

  private scheduleNextFetch() {
    // Ensure fetch isn't scheduled multiple times if already running
    if (this.isFetching) return;
    const interval = this.getNextInterval();
    console.log(`Scheduling next fetch in ${interval} seconds.`);
    // Use a timeout handle if needed to clear it on shutdown
    setTimeout(() => this.getNotifications(), interval * 1000);
  }

  async getNotifications() {
    if (this.isFetching) {
      console.log("Fetch already in progress, skipping.");
      return;
    }
    this.isFetching = true;
    console.log(`Fetching notifications... (using lastId: ${this.lastId})`);

    try {
      const params = [`limit=5`];
      // Only add 'before' if lastId is defined and not an empty string
      if (this.lastId) {
        params.push(`before=${this.lastId}`);
      }

      const apiUrl = `https://sora.com/backend/notif?${params.join("&")}`;
      console.log(`Requesting URL: ${apiUrl}`);

      const req = await fetch(apiUrl, {
        headers,
      });

      if (!req.ok) {
        // Log response body for debugging if possible
        const errorBody = await req
          .text()
          .catch(() => "Could not read error body");
        throw new Error(
          `API request failed with status ${req.status}. Body: ${errorBody}`
        );
      }

      const res: IResponse = await req.json();

      if (res.last_id === null) {
        console.log("No new notifications.");
        return;
      }

      // Validate the response structure
      if (!res || !Array.isArray(res.data) || typeof res.last_id !== "string") {
        console.warn(
          "Received invalid response structure:",
          JSON.stringify(res)
        );
        // Don't schedule next fetch immediately, let the finally block handle it
        return;
      }

      console.log(
        `Received ${res.data.length} notifications. API's last_id: ${res.last_id}`
      );

      if (res.data.length === 0) {
        console.log("No new notifications found.");
        // Update status based on the API's last_id if it matches ours and handle progress message
        const latestPayload = res.data.find(
          (el) => el.payload.id === res.last_id
        )?.payload;
        if (latestPayload && latestPayload.id === this.lastId) {
          await this.handleProgressUpdate(latestPayload);
        } else {
          // If no relevant payload, ensure progress message is cleared if it exists
          await this.clearProgressMessageIfNeeded(undefined); // Pass undefined status
        }
        return; // Nothing new to process
      }

      console.log(`Processing ${res.data.length} new notifications.`);

      // Process notifications. Assuming API returns newest first.
      // Process them in reverse order (oldest new notification first)
      // so that if processing stops midway, lastId is set to the last *successfully* processed one.
      const notificationsToProcess = res.data.slice().reverse();
      let latestSuccessfullyProcessedId = this.lastId; // Start with current lastId
      this.lastGenerationTime = Date.now();

      for (const item of notificationsToProcess) {
        const payload = item.payload;
        console.log(
          `Processing notification ID: ${payload.id}, Status: ${payload.status}`
        );

        // Only process and send notifications for *succeeded* tasks
        if (payload.status === TaskStatus.succeeded) {
          console.log(
            `Task ${payload.id} succeeded. Attempting to send notification...`
          );
          try {
            if (
              payload.type === TaskType.imageGen &&
              payload.generations?.length
            ) {
              await this.sendStickers(payload.generations);
            } else if (
              payload.type === TaskType.videoGen &&
              payload.generations?.length
            ) {
              // Send videos as a media group
              const mediaGroup = payload.generations
                .map((gen) => {
                  if (gen.url) {
                    return {
                      type: "video" as const, // Explicit type
                      media: {
                        url: gen.url,
                        filename:
                          (gen.title || payload.title || payload.id) + ".mp4",
                      },
                      caption: this.getMessage(payload, {
                        linkText: gen.title || payload.title, // Use generation title or fallback
                        linkUrl: gen.url, // Link to the specific video
                      }),
                      parse_mode: "HTML" as const,
                    };
                  }
                  console.warn(
                    `Missing video URL for generation in task ${payload.id}`
                  );
                  return null; // Filter out missing URLs
                })
                .filter(Boolean); // Remove null entries

              if (mediaGroup.length > 0) {
                await this.bot.telegram.sendMediaGroup(
                  process.env.CHAT_ID!,
                  mediaGroup as any
                ); // Type assertion needed for complex type
              } else {
                console.warn(
                  `No valid video URLs found to send for task ${payload.id}`
                );
              }
            } else {
              console.log(
                `Task ${payload.id} succeeded but type is ${payload.type} or no generations found. Skipping send.`
              );
            }

            // If sending was successful (or skipped appropriately), update the latest processed ID
            latestSuccessfullyProcessedId = payload.id;
            console.log(
              `Successfully processed notification for ${payload.id}. Updated latestSuccessfullyProcessedId to ${latestSuccessfullyProcessedId}.`
            );

            // Clear any progress message after sending the final result
            await this.clearProgressMessageIfNeeded(payload.status);
          } catch (sendError) {
            console.error(
              `Failed to send notification for ${payload.id}:`,
              sendError
            );
            // Stop processing further notifications in this batch on send error
            // to avoid skipping over a failed one and incorrectly updating lastId.
            console.log(
              `Stopping processing for this batch due to send error for ${payload.id}. lastId remains ${this.lastId}.`
            );
            return; // Exit the getNotifications function
          }
        } else {
          console.log(
            `Task ${payload.id} status is ${payload.status}. Skipping send, will handle progress update later.`
          );
          // Keep track of the ID even if not 'succeeded' for potential progress updates
          // latestSuccessfullyProcessedId = payload.id; // No, only update for SUCCEEDED
        }
      } // End of loop through notificationsToProcess

      // Persist the very latest ID that was successfully processed
      if (
        latestSuccessfullyProcessedId &&
        latestSuccessfullyProcessedId !== this.lastId
      ) {
        await this.setLastId(latestSuccessfullyProcessedId);
      }

      // After processing all new items, handle progress update based on the *most recent* item overall from the API response
      // This ensures we show progress for the absolute latest task, even if older ones were processed.
      const absoluteLatestPayload = res.data[0]?.payload; // API returns newest first
      if (absoluteLatestPayload) {
        await this.handleProgressUpdate(absoluteLatestPayload);
      }
    } catch (error) {
      console.error("Error during notification fetch/processing:", error);
      // Consider more robust error handling (e.g., exponential backoff on certain errors)
    } finally {
      this.isFetching = false;
      // Always schedule the next fetch, even if errors occurred.
      this.scheduleNextFetch();
    }
  }

  private async handleProgressUpdate(payload: IPayload) {
    this.status = payload.status; // Update overall status based on this payload

    if (this.status === TaskStatus.running && payload.progress_pct != null) {
      // Check for null/undefined progress
      const progress = Math.round(payload.progress_pct * 100);

      // Only update if progress changed or message doesn't exist
      if (this.progress !== progress || !this.progressMessageId) {
        this.progress = progress;
        const text = this.getMessage(payload, { suffix: `${progress}%` });
        console.log(`Updating progress for ${payload.id}: ${progress}%`);

        if (this.progressMessageId) {
          try {
            await this.bot.telegram.editMessageText(
              process.env.CHAT_ID!,
              this.progressMessageId,
              undefined, // inline_message_id
              text,
              { parse_mode: "HTML" }
            );
          } catch (editError: any) {
            // If message expired or not found (400), send a new one
            if (
              editError.response?.error_code === 400 &&
              editError.description?.includes("message to edit not found")
            ) {
              console.warn(
                "Failed to edit progress message (likely deleted/expired), sending new one."
              );
              delete this.progressMessageId; // Reset ID
              const message = await this.bot.telegram.sendMessage(
                process.env.CHAT_ID!,
                text,
                { parse_mode: "HTML", disable_notification: true }
              );
              this.progressMessageId = message.message_id;
            } else {
              console.error("Failed to edit progress message:", editError);
              // Consider deleting the message ID if edit fails persistently
              // delete this.progressMessageId;
            }
          }
        } else {
          // Send initial progress message
          const message = await this.bot.telegram.sendMessage(
            process.env.CHAT_ID!,
            text,
            { parse_mode: "HTML", disable_notification: true }
          );
          this.progressMessageId = message.message_id;
        }
      }
    } else {
      // If the status is NOT running, clear the progress message.
      await this.clearProgressMessageIfNeeded(this.status);
    }
  }

  private async clearProgressMessageIfNeeded(currentStatus?: TaskStatus) {
    // Clear progress if message exists and status is not 'running'
    if (this.progressMessageId && currentStatus !== TaskStatus.running) {
      console.log(
        `Task status is ${
          currentStatus || "not running"
        }. Deleting progress message (ID: ${this.progressMessageId}).`
      );
      try {
        await this.bot.telegram.deleteMessage(
          process.env.CHAT_ID!,
          this.progressMessageId
        );
      } catch (deleteError: any) {
        // Ignore if message is already deleted (400 error)
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

  private getNextInterval() {
    let interval;

    switch (this.status) {
      case TaskStatus.queued:
        interval = 15; // 15 seconds
        break;
      case TaskStatus.running:
        interval = 10; // 10 seconds
        break;
      default:
        interval = this.getDefaultNextInterval();
      // Add cases for failed, etc. if different intervals are desired
      // case TaskStatus.failed:
      //   interval = 60; // Check less often after failure?
      //   break;
    }
    // Add some jitter to avoid thundering herd
    // interval += Math.random() * 2 - 1; // +/- 1 second
    return Math.max(5, interval); // Ensure minimum interval (e.g., 5 seconds)
  }

  private getDefaultNextInterval() {
    const secondsSinceLastGen =
      (Date.now() - (this.lastGenerationTime || 0)) / 1000;

    if (secondsSinceLastGen < 120) return 25;
    else if (secondsSinceLastGen < 300) return 50;
    else if (secondsSinceLastGen < 1800) return 120;
    else return 600;
  }

  private getMessage(payload: IPayload, opts: IGetMessageOptions) {
    // Construct the base URL for the task
    const baseUrl = `https://sora.com/t/${payload.id}`;
    // Use the specific generation URL if provided, otherwise fallback to task URL
    const url = opts.linkUrl || baseUrl;
    // Use generation title, then task title, then a generic fallback
    const linkText = opts?.linkText || payload.title || `Task ${payload.id}`;
    // Escape HTML entities in linkText to prevent injection issues if title contains HTML
    const escapedLinkText = linkText.replace(/</g, "<").replace(/>/g, ">");

    const link = `<a href="${url}">${escapedLinkText}</a>`;

    // Add suffix if provided
    return opts.suffix ? `${link} ${opts.suffix}` : link;
  }

  private async sendStickers(generations: IGeneration[]) {
    // Send images as stickers
    for (const gen of generations) {
      const req = await fetch(gen.encodings.source.path);
      const buffer = await req.arrayBuffer();
      const fileName = `${gen.id}.webp`;
      const tempFile = `./temp/${fileName}`;
      await fs.writeFile(tempFile, Buffer.from(buffer));
      const files = await cropFeatheredStickers(fileName);
      await fs.unlink(tempFile);
      for (const file of files || []) {
        await this.bot.telegram.sendSticker(process.env.CHAT_ID!, {
          source: file,
        });
        await fs.unlink(file);
      }
    }
  }
}

interface IGetMessageOptions {
  linkUrl?: string; // URL specific to the generation (video/image)
  linkText?: string; // Text for the link (generation title or task title)
  suffix?: string; // Optional suffix (e.g., progress percentage)
}

// --- Initialization ---

// Validate essential environment variables before starting
const requiredEnvVars = ["BOT_TOKEN", "TOKEN", "COOKIE", "CHAT_ID"];
const missingEnvVars = requiredEnvVars.filter(
  (varName) => !process.env[varName]
);

if (missingEnvVars.length > 0) {
  console.error(
    `Missing required environment variables: ${missingEnvVars.join(
      ", "
    )}. Exiting.`
  );
  process.exit(1); // Exit with error code
}

// Start the notificator
console.log("Starting Sora Notificator...");
new Notificator();

// Optional: Add graceful shutdown handling
process.once("SIGINT", () => {
  console.log("Received SIGINT. Shutting down...");
  // Add any cleanup logic here if needed (e.g., clear timeouts)
  process.exit(0);
});
process.once("SIGTERM", () => {
  console.log("Received SIGTERM. Shutting down...");
  // Add any cleanup logic here
  process.exit(0);
});
