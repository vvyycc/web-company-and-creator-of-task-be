// src/socket.ts
import type http from "http";
import { Server as SocketIOServer } from "socket.io";

let ioInstance: SocketIOServer | null = null;

export function initSocket(server: http.Server) {
  const FRONTEND_ORIGIN =
    process.env.FRONTEND_ORIGIN || "http://localhost:3000";

  ioInstance = new SocketIOServer(server, {
    path: "/socket.io",
    cors: {
      origin: FRONTEND_ORIGIN,
      credentials: true,
      methods: ["GET", "POST", "OPTIONS"],
    },
  });

  ioInstance.on("connection", (socket) => {
    console.log("[socket] connected:", socket.id);

    socket.on("community:join", ({ projectId }: { projectId?: string }) => {
      if (!projectId) return;
      const room = `community:${projectId}`;
      socket.join(room);
      console.log("[socket] join:", socket.id, room);
    });

    socket.on("community:leave", ({ projectId }: { projectId?: string }) => {
      if (!projectId) return;
      const room = `community:${projectId}`;
      socket.leave(room);
      console.log("[socket] leave:", socket.id, room);
    });

    socket.on("disconnect", (reason) => {
      console.log("[socket] disconnected:", socket.id, reason);
    });
  });

  return ioInstance;
}

export function getIO() {
  if (!ioInstance) {
    throw new Error(
      "Socket.IO no inicializado. Llama a initSocket(server) primero."
    );
  }
  return ioInstance;
}
