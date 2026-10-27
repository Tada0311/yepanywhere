#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { homedir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");

function isUnixSocket(candidate) {
  try {
    return statSync(candidate).isSocket();
  } catch {
    return false;
  }
}

function discoverSocket() {
  const configured = process.env.YEP_ANYWHERE_CODEX_APP_SERVER_SOCKET?.trim();
  if (configured) {
    if (!isUnixSocket(configured)) {
      throw new Error(
        `Configured Codex app-server socket is unavailable: ${configured}`,
      );
    }
    return configured;
  }

  const codexHome = process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
  const controlSocket = path.join(
    codexHome,
    "app-server-control",
    "app-server-control.sock",
  );
  if (isUnixSocket(controlSocket)) return controlSocket;

  const daemonDir = path.join(
    process.env.TMPDIR ?? "/tmp",
    `codex-daemon-${process.getuid()}`,
  );
  let candidates = [];
  try {
    candidates = readdirSync(daemonDir)
      .map((name) => path.join(daemonDir, name))
      .filter(isUnixSocket);
  } catch {
    return null;
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new Error(
      `Found ${candidates.length} Codex app-server sockets; refusing to select one`,
    );
  }
  return null;
}

function runFallback(codexCommand, codexArgs) {
  const child = spawn(codexCommand, codexArgs, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  child.on("error", (error) => {
    process.stderr.write(
      `Codex app-server fallback failed: ${error.message}\n`,
    );
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  process.on("SIGINT", () => child.kill("SIGINT"));
}

function runShared(socketPath) {
  const socket = new WebSocket("ws://localhost/", {
    createConnection: () => connect(socketPath),
  });
  let inputBuffer = "";
  let pendingInput = [];
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    if (
      socket.readyState === WebSocket.CONNECTING ||
      socket.readyState === WebSocket.OPEN
    ) {
      socket.close();
    }
  };

  const sendLine = (line) => {
    if (!line) return;
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(line);
    } else {
      pendingInput.push(line);
    }
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    inputBuffer += chunk;
    const lines = inputBuffer.split("\n");
    inputBuffer = lines.pop() ?? "";
    for (const line of lines) sendLine(line.trim());
  });
  process.stdin.on("end", () => {
    if (inputBuffer.trim()) sendLine(inputBuffer.trim());
    inputBuffer = "";
    close();
  });

  socket.on("open", () => {
    for (const line of pendingInput) socket.send(line);
    pendingInput = [];
  });
  socket.on("message", (data) => {
    process.stdout.write(`${data.toString()}\n`);
  });
  socket.on("error", (error) => {
    if (!closed) {
      process.stderr.write(
        `Codex shared app-server connection failed: ${error.message}\n`,
      );
    }
    process.exitCode = 1;
  });
  socket.on("close", () => {
    closed = true;
    process.exit();
  });

  process.on("SIGTERM", close);
  process.on("SIGINT", close);
}

const [codexCommand, ...codexArgs] = process.argv.slice(2);
if (!codexCommand) {
  process.stderr.write("Missing Codex command for app-server bridge\n");
  process.exit(64);
}

try {
  const socketPath = discoverSocket();
  if (socketPath) {
    runShared(socketPath);
  } else {
    runFallback(codexCommand, codexArgs);
  }
} catch (error) {
  process.stderr.write(
    `Codex shared app-server bridge failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exit(1);
}
