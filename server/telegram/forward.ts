import type { TelegramMessage } from "./types";

export interface ForwardCapture {
  title: string;
  notes: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const cleanLabel = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 120);
  return cleaned || undefined;
};

const usernameLabel = (value: unknown): string | undefined => {
  const username = cleanLabel(value);
  return username && /^[A-Za-z0-9_]{5,32}$/.test(username) ? `@${username}` : undefined;
};

const disclosedSourceLabel = (message: TelegramMessage): string | undefined => {
  if (isRecord(message.forward_origin)) {
    const type = message.forward_origin.type;
    if (type === "hidden_user") return undefined;
    const user = isRecord(message.forward_origin.sender_user) ? message.forward_origin.sender_user : undefined;
    const chat = isRecord(message.forward_origin.chat)
      ? message.forward_origin.chat
      : isRecord(message.forward_origin.sender_chat)
        ? message.forward_origin.sender_chat
        : undefined;
    return usernameLabel(user?.username)
      ?? usernameLabel(chat?.username)
      ?? cleanLabel(chat?.title);
  }
  return usernameLabel(message.forward_from?.username)
    ?? usernameLabel(message.forward_from_chat?.username)
    ?? cleanLabel(message.forward_from_chat?.title);
};

export const isForwarded = (message: TelegramMessage): boolean =>
  Boolean(message.forward_origin || message.forward_from || message.forward_from_chat);

/**
 * Preserve the user-visible forwarded content, not Telegram's raw origin object.
 * Raw origin data is larger, can contain third-party identifiers, and is not
 * needed to make capture durable. Hidden senders remain hidden.
 */
export const extractForwardCapture = (message: TelegramMessage): ForwardCapture | null => {
  if (!isForwarded(message)) return null;
  const forwardedText = (message.text ?? message.caption ?? "").trim().slice(0, 9_900);
  if (!forwardedText) return null;
  const source = disclosedSourceLabel(message);
  const prefix = source ? `Forwarded from Telegram (${source}):` : "Forwarded from Telegram:";
  const notes = `${prefix}\n\n${forwardedText}`.slice(0, 10_000);
  const firstLine = forwardedText.split(/\r?\n/, 1)[0].trim();
  return { title: (firstLine || "Forwarded Telegram message").slice(0, 240), notes };
};
