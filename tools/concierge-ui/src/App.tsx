import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type SendStatus = "idle" | "sending" | "error";
type LoginStatus = "idle" | "signing-in" | "error";

const ACCESS_TOKEN_STORAGE_KEY = "concierge-ui.accessToken";

export default function App() {
  const [accessToken, setAccessToken] = useState<string | null>(() => sessionStorage.getItem(ACCESS_TOKEN_STORAGE_KEY));

  if (!accessToken) {
    return <LoginForm onSignedIn={setAccessToken} />;
  }

  return (
    <Chat
      accessToken={accessToken}
      onSignOut={() => {
        sessionStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
        setAccessToken(null);
      }}
    />
  );
}

function LoginForm({ onSignedIn }: { onSignedIn: (accessToken: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<LoginStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");

  async function signIn() {
    setStatus("signing-in");
    setErrorMessage("");

    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body = (await response.json()) as { accessToken?: string; error?: string };

      if (!response.ok || !body.accessToken) {
        setStatus("error");
        setErrorMessage(body.error ?? `sign-in failed with status ${response.status}`);
        return;
      }

      sessionStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, body.accessToken);
      onSignedIn(body.accessToken);
    } catch (error) {
      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "sign-in failed");
    }
  }

  return (
    <div className="app">
      <h1>Concierge UI</h1>
      <p className="hint">
        Sign in with a Cognito user pool user (issue #17). The stack provisions one test user —
        see the README for its email and how to fetch its generated password.
      </p>

      <label className="field">
        Email
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="wayfarer-test-user@example.com"
        />
      </label>

      <label className="field">
        Password
        <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
      </label>

      <div className="send-row">
        <button onClick={signIn} disabled={status === "signing-in" || !email.trim() || !password}>
          {status === "signing-in" ? "Signing in…" : "Sign in"}
        </button>
      </div>

      {status === "error" && <div className="error">{errorMessage}</div>}
    </div>
  );
}

function Chat({ accessToken, onSignOut }: { accessToken: string; onSignOut: () => void }) {
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
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ message, sessionId }),
      });

      if (response.status === 401 || response.status === 403) {
        setStatus("error");
        setErrorMessage("session expired — please sign in again");
        onSignOut();
        return;
      }

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
        <button onClick={onSignOut}>Sign out</button>
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
