import { useCallback, useEffect, useRef, useState } from "react";

interface PublicTask {
  id: string;
  title: string;
  scheduledFor: string;
  scheduledTime: string | null;
  tags: string[];
  isFrog: boolean;
  status: string;
}

interface CapturePayload {
  title: string;
  schedulePrecision: "day";
  scheduledFor: string;
  scheduledTime?: string;
  estimatedMinutes?: number;
  tags?: string[];
}

interface PendingCapture { operationId: string; payload: CapturePayload }

declare global {
  interface Window {
    Telegram?: { WebApp: {
      initData: string;
      isActive?: boolean;
      ready(): void;
      expand(): void;
      openLink(url: string): void;
      onEvent?(event: "activated" | "deactivated", handler: () => void): void;
      offEvent?(event: "activated" | "deactivated", handler: () => void): void;
    } };
  }
}

const API = "/api/v1/telegram/mini";
const pendingKey = "goalflow.telegram-mini.pending-capture.v1";
const foregroundPollMs = 30_000;
const maximumWakeFrameBytes = 8 * 1024;

const readPending = (): PendingCapture | null => {
  try {
    const value = JSON.parse(sessionStorage.getItem(pendingKey) ?? "null") as Partial<PendingCapture> | null;
    if (!value || typeof value.operationId !== "string" || typeof value.payload?.title !== "string"
      || typeof value.payload.scheduledFor !== "string") return null;
    return value as PendingCapture;
  } catch { return null; }
};

const errorMessage = async (response: Response, fallback: string): Promise<string> => {
  try {
    const body = await response.json() as { error?: { message?: string } };
    return body.error?.message || fallback;
  } catch { return fallback; }
};

const consumeWakeStream = async (
  stream: ReadableStream<Uint8Array>,
  onWake: () => void
): Promise<void> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > maximumWakeFrameBytes) throw new Error("Wake stream frame exceeded its bound.");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const lines = frame.split("\n");
        const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
        const data = lines.find(line => line.startsWith("data:"))?.slice(5).trim();
        if (event === "wake" && data === "{}") onWake();
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
};

export const App = () => {
  const exchangeAttempted = useRef(false);
  const loadInFlight = useRef<Promise<boolean> | null>(null);
  const [current, setCurrent] = useState<PublicTask | null>(null);
  const [today, setToday] = useState<PublicTask[]>([]);
  const [gate, setGate] = useState("loading");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCapture, setShowCapture] = useState(Boolean(readPending()));
  const initialPending = readPending();
  const [title, setTitle] = useState(initialPending?.payload.title ?? "");
  const [date, setDate] = useState(initialPending?.payload.scheduledFor ?? "");
  const [time, setTime] = useState(initialPending?.payload.scheduledTime ?? "");
  const [duration, setDuration] = useState(initialPending?.payload.estimatedMinutes?.toString() ?? "");
  const [tags, setTags] = useState(initialPending?.payload.tags?.join(", ") ?? "");

  const exchange = useCallback(async (): Promise<void> => {
    if (exchangeAttempted.current) {
      throw new Error("Reopen the Tsurfing Mini App from Telegram to renew its secure session.");
    }
    exchangeAttempted.current = true;
    const initData = window.Telegram?.WebApp?.initData ?? "";
    if (!initData) throw new Error("Open this page from the verified Tsurfing Telegram bot.");
    const response = await fetch(`${API}/session`, {
      method: "POST",
      credentials: "same-origin",
      headers: { authorization: `tma ${initData}` }
    });
    if (!response.ok) throw new Error(await errorMessage(response, "Telegram session could not be created."));
    const body = await response.json() as { expiresAt?: string };
    if (!body.expiresAt || !Number.isFinite(Date.parse(body.expiresAt))) {
      throw new Error("Telegram session acknowledgment was incomplete.");
    }
  }, []);

  const load = useCallback((): Promise<boolean> => {
    if (loadInFlight.current) return loadInFlight.current;
    const operation = (async () => {
      setBusy(true);
      setError(null);
      try {
        const fetchSnapshot = () => Promise.all([
          fetch(`${API}/current`, { credentials: "same-origin" }),
          fetch(`${API}/today`, { credentials: "same-origin" })
        ]);
        let [currentResponse, todayResponse] = await fetchSnapshot();
        if (currentResponse.status === 401 || todayResponse.status === 401) {
          await exchange();
          [currentResponse, todayResponse] = await fetchSnapshot();
        }
        if (!currentResponse.ok || !todayResponse.ok) {
          throw new Error(await errorMessage(
            !currentResponse.ok ? currentResponse : todayResponse,
            "Tsurfing could not be loaded."
          ));
        }
        const currentBody = await currentResponse.json() as { current: PublicTask | null; gate: string };
        const todayBody = await todayResponse.json() as { queue: PublicTask[]; gate: string };
        setCurrent(currentBody.current);
        setToday(todayBody.queue ?? []);
        setGate(currentBody.gate ?? todayBody.gate ?? "unknown");
        return true;
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Tsurfing could not be loaded.");
        return false;
      } finally {
        setBusy(false);
        loadInFlight.current = null;
      }
    })();
    loadInFlight.current = operation;
    return operation;
  }, [exchange]);

  useEffect(() => {
    const telegram = window.Telegram?.WebApp;
    telegram?.ready();
    telegram?.expand();
    let stopped = false;
    let telegramActive = telegram?.isActive !== false;
    let generation = 0;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let streamController: AbortController | undefined;

    const shouldConnect = () => !stopped && telegramActive
      && document.visibilityState !== "hidden" && navigator.onLine;
    const clearReconnect = () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    };
    const scheduleReconnect = (targetGeneration: number) => {
      if (!shouldConnect() || targetGeneration !== generation || reconnectTimer) return;
      const delay = Math.min(500 * (2 ** Math.min(reconnectAttempt, 6)), 30_000);
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        void connect(targetGeneration);
      }, delay);
    };
    const connect = async (targetGeneration: number) => {
      if (!shouldConnect() || targetGeneration !== generation) return;
      const controller = new AbortController();
      streamController = controller;
      try {
        const response = await fetch(`${API}/events`, {
          method: "POST",
          credentials: "same-origin",
          headers: { accept: "text/event-stream" },
          signal: controller.signal
        });
        if (!response.ok || !response.body) {
          if (response.status === 401) await load();
          else throw new Error(await errorMessage(response, "Live updates are reconnecting."));
          return;
        }
        reconnectAttempt = 0;
        await consumeWakeStream(response.body, () => { void load(); });
      } catch (reason) {
        if (!(reason instanceof DOMException && reason.name === "AbortError") && shouldConnect()) {
          // The required 30-second foreground pull remains active while the
          // wake-only relay reconnects; no local mutation is acknowledged here.
        }
      } finally {
        if (streamController === controller) streamController = undefined;
        scheduleReconnect(targetGeneration);
      }
    };
    const restart = () => {
      generation += 1;
      const targetGeneration = generation;
      clearReconnect();
      streamController?.abort();
      streamController = undefined;
      if (shouldConnect()) {
        void load();
        void connect(targetGeneration);
      }
    };
    const activated = () => { telegramActive = true; restart(); };
    const deactivated = () => {
      telegramActive = false;
      generation += 1;
      clearReconnect();
      streamController?.abort();
      streamController = undefined;
    };
    const visibilityChanged = () => document.visibilityState === "hidden" ? deactivated() : activated();
    const online = () => restart();
    const focused = () => restart();
    const poll = setInterval(() => { if (shouldConnect()) void load(); }, foregroundPollMs);

    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("online", online);
    window.addEventListener("focus", focused);
    telegram?.onEvent?.("activated", activated);
    telegram?.onEvent?.("deactivated", deactivated);
    void load().then(loaded => { if (loaded) restart(); });

    return () => {
      stopped = true;
      generation += 1;
      clearInterval(poll);
      clearReconnect();
      streamController?.abort();
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.removeEventListener("online", online);
      window.removeEventListener("focus", focused);
      telegram?.offEvent?.("activated", activated);
      telegram?.offEvent?.("deactivated", deactivated);
    };
  }, [load]);

  const capture = async () => {
    if (!title.trim() || !date) return;
    const existing = readPending();
    const payload: CapturePayload = existing?.payload ?? {
      title: title.trim(),
      schedulePrecision: "day",
      scheduledFor: date,
      ...(time ? { scheduledTime: time } : {}),
      ...(duration ? { estimatedMinutes: Number(duration) } : {}),
      ...(tags ? { tags: tags.split(",").map(tag => tag.trim().replace(/^#/, "")).filter(Boolean) } : {})
    };
    const pending: PendingCapture = existing ?? { operationId: crypto.randomUUID(), payload };
    sessionStorage.setItem(pendingKey, JSON.stringify(pending));
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${API}/capture`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "idempotency-key": pending.operationId
        },
        body: JSON.stringify(pending.payload)
      });
      if (!response.ok) throw new Error(await errorMessage(response, "Task was not acknowledged. Retry preserves the same operation ID."));
      const body = await response.json() as { task?: PublicTask; operationId?: string };
      if (body.operationId !== pending.operationId || body.task?.id !== pending.operationId) {
        throw new Error("Task storage acknowledgment did not match. Retry preserves the same operation ID.");
      }
      sessionStorage.removeItem(pendingKey);
      setTitle(""); setDate(""); setTime(""); setDuration(""); setTags(""); setShowCapture(false);
      await load();
      window.Telegram?.WebApp?.openLink(`${window.location.origin}/?taskId=${body.task.id}&view=current`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Task was not acknowledged.");
    } finally { setBusy(false); }
  };

  const discardDraft = () => {
    sessionStorage.removeItem(pendingKey);
    setTitle(""); setDate(""); setTime(""); setDuration(""); setTags(""); setShowCapture(false); setError(null);
  };

  if (busy && !current && today.length === 0) return <main className="container"><section className="card">Loading…</section></main>;

  return <main className="container">
    {error && <section className="card error">{error} <button className="btn secondary" onClick={() => void load()}>Retry</button></section>}
    {readPending() && <section className="card notice">A saved capture is waiting for verified server acknowledgment. Its fields stay locked so every retry uses the same operation ID and payload.</section>}
    <section className="card">
      <div className="eyebrow">CURRENT</div>
      {current ? <>
        <strong>{current.isFrog ? "🐸 " : ""}{current.title}</strong>
        <p className="muted">{current.scheduledTime ? `${current.scheduledTime} · ` : ""}{current.tags.map(tag => `#${tag}`).join(" ")}</p>
        <button className="btn" onClick={() => window.Telegram?.WebApp?.openLink(`${window.location.origin}/?taskId=${current.id}&view=current`)}>Open in Tsurfing</button>
      </> : <p className="muted">{gate === "empty" ? "Nothing scheduled for today." : `Planning required (${gate}).`}</p>}
    </section>
    <section className="card">
      <div className="eyebrow">TODAY</div>
      <p className="muted">{today.length} open</p>
      {today.slice(0, 5).map((task, index) => <div className="task" key={task.id}>{index === 0 ? "→ " : ""}{task.isFrog ? "🐸 " : ""}{task.title}</div>)}
    </section>
    {!showCapture ? <button className="btn" onClick={() => setShowCapture(true)}>+ Capture task</button> : <section className="card">
      <label className="label" htmlFor="capture-title">Title</label>
      <input id="capture-title" className="input" value={title} onChange={event => setTitle(event.target.value)} maxLength={240} disabled={Boolean(readPending())} />
      <label className="label" htmlFor="capture-date">Date</label>
      <input id="capture-date" className="input" type="date" value={date} onChange={event => setDate(event.target.value)} disabled={Boolean(readPending())} />
      <label className="label" htmlFor="capture-time">Time (optional)</label>
      <input id="capture-time" className="input" type="time" value={time} onChange={event => setTime(event.target.value)} disabled={Boolean(readPending())} />
      <label className="label" htmlFor="capture-duration">Minutes (optional)</label>
      <input id="capture-duration" className="input" type="number" min="1" max="1440" value={duration} onChange={event => setDuration(event.target.value)} disabled={Boolean(readPending())} />
      <label className="label" htmlFor="capture-tags">Tags (optional, comma-separated)</label>
      <input id="capture-tags" className="input" value={tags} onChange={event => setTags(event.target.value)} disabled={Boolean(readPending())} />
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn" disabled={busy || !title.trim() || !date} onClick={() => void capture()}>{readPending() ? "Retry capture" : "Create"}</button>
        <button className="btn secondary" disabled={busy} onClick={discardDraft}>{readPending() ? "Discard saved draft" : "Cancel"}</button>
      </div>
    </section>}
  </main>;
};
