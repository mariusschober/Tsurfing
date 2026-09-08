import { describe, expect, it, vi } from "vitest";
import { readConfig } from "../config";
import { configureTelegramDeployment } from "./deployment";

const enabledConfig = () => readConfig({
  APP_ORIGIN: "https://staging.tsurfing.com",
  TELEGRAM_ENABLED: "true",
  TELEGRAM_BOT_TOKEN: "123456:TEST_ONLY_TOKEN_VALUE",
  TELEGRAM_BOT_USERNAME: "tstagebot",
  TELEGRAM_WEBHOOK_SECRET: "TEST_ONLY_WEBHOOK_SECRET_32_CHARS"
});

const response = (result: unknown, status = 200) => new Response(
  JSON.stringify(status === 200 ? { ok: true, result } : { ok: false }),
  { status, headers: { "content-type": "application/json" } }
);

describe("Telegram deployment configuration", () => {
  it("does nothing while Telegram remains disabled", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(configureTelegramDeployment(readConfig({}), request)).resolves.toEqual({ configured: false });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a token for a different bot before changing external configuration", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response({
      id: 7,
      is_bot: true,
      username: "tsurfbot"
    }));
    await expect(configureTelegramDeployment(enabledConfig(), request))
      .rejects.toThrow("Telegram bot identity does not match this environment.");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("registers and verifies the exact webhook, Mini App, and bounded command set", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ id: 7, is_bot: true, username: "tstagebot" }))
      .mockResolvedValueOnce(response(true))
      .mockResolvedValueOnce(response(true))
      .mockResolvedValueOnce(response(true))
      .mockResolvedValueOnce(response({
        url: "https://staging.tsurfing.com/api/v1/telegram/webhook",
        allowed_updates: ["message", "callback_query"]
      }));

    await expect(configureTelegramDeployment(enabledConfig(), request)).resolves.toEqual({
      configured: true,
      username: "tstagebot",
      webhookUrl: "https://staging.tsurfing.com/api/v1/telegram/webhook",
      miniAppUrl: "https://staging.tsurfing.com/mini"
    });

    const calls = request.mock.calls.map(([url, options]) => ({
      method: String(url).split("/").at(-1),
      body: JSON.parse(String(options?.body ?? "{}")) as Record<string, unknown>
    }));
    expect(calls.map(call => call.method)).toEqual([
      "getMe",
      "setWebhook",
      "setChatMenuButton",
      "setMyCommands",
      "getWebhookInfo"
    ]);
    expect(calls[1].body).toMatchObject({
      url: "https://staging.tsurfing.com/api/v1/telegram/webhook",
      secret_token: "TEST_ONLY_WEBHOOK_SECRET_32_CHARS",
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false
    });
    expect(calls[2].body).toEqual({
      menu_button: {
        type: "web_app",
        text: "Open Tsurfing",
        web_app: { url: "https://staging.tsurfing.com/mini" }
      }
    });
  });

  it("fails closed when Telegram reports another webhook", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ id: 7, is_bot: true, username: "tstagebot" }))
      .mockResolvedValueOnce(response(true))
      .mockResolvedValueOnce(response(true))
      .mockResolvedValueOnce(response(true))
      .mockResolvedValueOnce(response({
        url: "https://attacker.example/webhook",
        allowed_updates: ["message", "callback_query"]
      }));
    await expect(configureTelegramDeployment(enabledConfig(), request))
      .rejects.toThrow("Telegram webhook verification did not match this environment.");
  });

  it("requires an explicit true result for every configuration mutation", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ id: 7, is_bot: true, username: "tstagebot" }))
      .mockResolvedValueOnce(response(false));
    await expect(configureTelegramDeployment(enabledConfig(), request))
      .rejects.toThrow("Telegram setWebhook was not accepted.");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not reflect Telegram error descriptions or token-bearing URLs", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response(false, 401));
    await expect(configureTelegramDeployment(enabledConfig(), request))
      .rejects.toThrow("Telegram getMe was rejected.");
  });
});
