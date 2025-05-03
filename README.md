# Sticker GPT

This project monitors notifications on the sora.com website. When new image generations are detected, it downloads the image, splits it into a 3x3 grid (9 parts), and sends the resulting image segments as stickers to a specified Telegram chat.

## Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js and pnpm:** The project uses `pnpm` for package management. You can find installation instructions on the [official Node.js website](https://nodejs.org/) and [pnpm website](https://pnpm.io/installation).
- **tsx:** This TypeScript execution tool needs to be installed globally. You can install it using pnpm:

  ```bash
  # Using pnpm (recommended for this project)
  pnpm install -g tsx

  # Or using npm
  npm install -g tsx
  ```

## Setup

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/sliterok/sticker-gpt
    cd sticker-gpt
    ```
2.  **Install dependencies:**

    ```bash
    # Using pnpm (recommended)
    pnpm install

    # Or using npm
    npm install
    ```

3.  **Configure Environment Variables:**
    Create a `.env` file in the project's root directory and add the following variables, replacing the placeholder values with your actual credentials:

    ```dotenv
    BOT_TOKEN=<your_telegram_bot_token>
    CHAT_ID=<your_telegram_chat_id>
    ```

    - `BOT_TOKEN`: Your Telegram bot's API token (obtainable from BotFather on Telegram).
    - `CHAT_ID`: The specific Telegram chat identifier where the stickers should be sent.

4.  **Configure Notification Headers:**
    Create a `headers.json` file in the root directory. This file must contain the necessary HTTP request headers required to interact with the sora.com `/backend/notif` endpoint.

    - **How to obtain headers:** Use your browser's developer tools (usually by pressing F12). Go to the Network tab, perform the action on sora.com that triggers the notification check, find the request to `/backend/notif`, and copy the request headers into the `headers.json` file.

    - **Example `headers.json` format:**
      ```json
      {
        "Cookie": "session_id=...",
        "Authorization": "Bearer ...",
        "User-Agent": "Mozilla/5.0 ...",
        "Accept": "application/json"
        // Add any other required headers here
      }
      ```
      _(Replace the example values with the actual headers you copied.)_

## Running the Project

Once the setup is complete, you can start the application using:

```bash
# Using pnpm (recommended)
pnpm start

# Or using npm
npm start
```

These commands execute the `notif.ts` script using `tsx`, which will begin monitoring for notifications.

## Prompting Guidelines

**Important:** When generating images that you intend to use with this tool, your prompt **must** include either:

- `telegram sticker`
- `transparent background`

This is crucial because the image processing script (`cv.ts`) requires images with an alpha channel (transparency). Standard generations have a white background, which will not work correctly for creating stickers with this tool. Specifying this requirement directly in the prompt ensures the generated image has the necessary transparency.

**Note:** Adding these phrases to a _preset_ is not sufficient; include it directly in the prompt text itself.

### Example Preset

While the core requirement is the transparency keyword, here's an example structure of a preset you might adapt for generating sticker packs:

```markdown
Generate a telegram sticker pack of a subject

Rules:
Singular subject
Turn whatever user described into a single thing

Perfectly centered
Place that one subject right in the middle of each 512×512 canvas.

Exactly nine stickers
Always output 9 images arranged in a 3×3 grid
```
