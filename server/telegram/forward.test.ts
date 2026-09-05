import { describe, expect, it } from "vitest";
import { extractForwardCapture, isForwarded } from "./forward";
import type { TelegramMessage } from "./types";

describe("Telegram forwarded capture", () => {
  it("preserves disclosed channel context and content without fabricating a link", () => {
    const message: TelegramMessage = {
      message_id: 1,
      chat: { id: 10 },
      text: "Review the revised offer",
      forward_origin: {
        type: "channel",
        chat: { id: -100123, username: "public_channel", title: "Public channel" },
        message_id: 42
      }
    };
    expect(isForwarded(message)).toBe(true);
    expect(extractForwardCapture(message)).toEqual({
      title: "Review the revised offer",
      notes: "Forwarded from Telegram (@public_channel):\n\nReview the revised offer"
    });
  });

  it("does not reveal a hidden sender and supports forwarded captions", () => {
    const message: TelegramMessage = {
      message_id: 2,
      chat: { id: 10 },
      caption: "Private context",
      forward_origin: { type: "hidden_user", sender_user_name: "Do not retain me" }
    };
    expect(extractForwardCapture(message)).toEqual({
      title: "Private context",
      notes: "Forwarded from Telegram:\n\nPrivate context"
    });
  });

  it("ignores ordinary messages and forwarded media without text", () => {
    expect(extractForwardCapture({ message_id: 3, chat: { id: 10 }, text: "Normal" })).toBeNull();
    expect(extractForwardCapture({ message_id: 4, chat: { id: 10 }, forward_origin: { type: "user" } })).toBeNull();
  });
});
