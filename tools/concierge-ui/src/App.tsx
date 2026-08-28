import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type SendStatus = "idle" | "sending" | "error";

export default function App() {
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const [message, setMessage] = useState("");
  const [reply, setReply] = useState<string | null>(null);
  const [status, setStatus] = useState<SendStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");

  async function send() {
    if (!message.trim()) {
      return;
    }

    setStatus("sending");
    setErrorMessage("");

    try {
      const response = await fetch("/api/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, sessionId }),
      });
      const body = (await response.json()) as { reply?: string; error?: string };

      if (!response.ok || body.error) {
        setStatus("error");
        setErrorMessage(body.error ?? `request failed with status ${response.status}`);
        return;
      }

      setReply(body.reply ?? "");
      setStatus("idle");
    } catch (error) {
      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "request failed");
    }
  }

  function newSession() {
    setSessionId(crypto.randomUUID());
    setReply(null);
    setStatus("idle");
    setErrorMessage("");
  }

  return (
    <div className="app">
      <h1>Concierge UI</h1>

      <div className="session-row">
        session: <code>{sessionId}</code>
        <button onClick={newSession}>New session</button>
      </div>

      <textarea
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        placeholder="Plan me a trip to Tokyo"
      />

      <div className="send-row">
        <button onClick={send} disabled={status === "sending" || !message.trim()}>
          {status === "sending" ? "Sending…" : "Send"}
        </button>
      </div>

      {status === "error" && <div className="error">{errorMessage}</div>}
      {reply !== null && status !== "error" && (
        <div className="reply">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{reply}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
