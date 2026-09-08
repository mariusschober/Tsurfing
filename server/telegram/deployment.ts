import type { AppConfig } from "../config";

type Fetch = typeof fetch;

type TelegramEnvelope<T> = {
  ok?: boolean;
  result?: T;
};

type TelegramIdentity = {
  id?: number;
  is_bot?: boolean;
  username?: string;
};

type TelegramWebhookInfo = {
  url?: string;
  allowed_updates?: string[];
};

const callTelegram = async <T>(
  token: string,
  method: string,
  payload: Record<string, unknown>,
  fetchImpl: Fetch
): Promise<T> => {
  let response: Response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000)
    });
  } catch {
    throw new Error(`Telegram ${method} could not be reached.`);
  }

  if (!response.ok) throw new Error(`Telegram ${method} was rejected.`);
  let envelope: TelegramEnvelope<T>;
  try {
    envelope = await response.json() as TelegramEnvelope<T>;
  } catch {
    throw new Error(`Telegram ${method} returned an unreadable acknowledgment.`);
  }
  if (envelope.ok !== true || envelope.result === undefined) {
    throw new Error(`Telegram ${method} returned an unverified acknowledgment.`);
  }
  return envelope.result;
};

export type TelegramDeployment = {
  configured: boolean;
  username?: string;
  webhookUrl?: string;
  miniAppUrl?: string;
};

/**
 * Configures only public Telegram endpoints. Credentials stay in process memory
 * and are never returned or logged. The bot identity check prevents a staging
 * token from silently registering the production bot (or vice versa).
 */
export const configureTelegramDeployment = async (
  config: AppConfig,
  fetchImpl: Fetch = fetch
): Promise<TelegramDeployment> => {
  if (config.TELEGRAM_ENABLED !== "true") return { configured: false };
  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_BOT_USERNAME || !config.TELEGRAM_WEBHOOK_SECRET) {
    throw new Error("Telegram deployment credentials are incomplete.");
  }

  const username = config.TELEGRAM_BOT_USERNAME.replace(/^@/, "");
  const identity = await callTelegram<TelegramIdentity>(config.TELEGRAM_BOT_TOKEN, "getMe", {}, fetchImpl);
  if (identity.is_bot !== true || !Number.isSafeInteger(identity.id) || identity.id! <= 0
    || identity.username?.toLowerCase() !== username.toLowerCase()) {
    throw new Error("Telegram bot identity does not match this environment.");
  }

  const webhookUrl = new URL("/api/v1/telegram/webhook", config.APP_ORIGIN).toString();
  const miniAppUrl = new URL("/mini", config.APP_ORIGIN).toString();
  const allowedUpdates = ["message", "callback_query"];

  const webhookAccepted = await callTelegram<boolean>(config.TELEGRAM_BOT_TOKEN, "setWebhook", {
    url: webhookUrl,
    secret_token: config.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: allowedUpdates,
    drop_pending_updates: false
  }, fetchImpl);
  if (webhookAccepted !== true) throw new Error("Telegram setWebhook was not accepted.");
  const menuAccepted = await callTelegram<boolean>(config.TELEGRAM_BOT_TOKEN, "setChatMenuButton", {
    menu_button: {
      type: "web_app",
      text: "Open Tsurfing",
      web_app: { url: miniAppUrl }
    }
  }, fetchImpl);
  if (menuAccepted !== true) throw new Error("Telegram setChatMenuButton was not accepted.");
  const commandsAccepted = await callTelegram<boolean>(config.TELEGRAM_BOT_TOKEN, "setMyCommands", {
    commands: [
      { command: "current", description: "Show the current task" },
      { command: "today", description: "Show today's queue" },
      { command: "add", description: "Capture a task" },
      { command: "done", description: "Complete the current task" },
      { command: "skip", description: "Move the current task to the end" },
      { command: "help", description: "Show Tsurfing commands" }
    ]
  }, fetchImpl);
  if (commandsAccepted !== true) throw new Error("Telegram setMyCommands was not accepted.");

  const webhook = await callTelegram<TelegramWebhookInfo>(
    config.TELEGRAM_BOT_TOKEN,
    "getWebhookInfo",
    {},
    fetchImpl
  );
  const actualUpdates = new Set(webhook.allowed_updates ?? []);
  if (webhook.url !== webhookUrl || allowedUpdates.some(update => !actualUpdates.has(update))) {
    throw new Error("Telegram webhook verification did not match this environment.");
  }

  return { configured: true, username, webhookUrl, miniAppUrl };
};
