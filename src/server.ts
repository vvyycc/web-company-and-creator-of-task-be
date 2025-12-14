// src/server.ts
import http from "http";
import cors from "cors";
import dotenv from "dotenv";
import express, { Request, Response } from "express";
import { sendContactEmail, ContactMessage } from "./services/mailer";
import projectsRouter from "./routes/projects";
import stripeRouter from "./routes/stripe";
import billingRouter, { billingWebhookHandler } from "./routes/billing";
import communityRouter from "./routes/community";
import verificationRouter from "./routes/verification";
import { connectMongo } from "./db/mongo";
import { initSocket } from "./socket";

dotenv.config();

const app = express();
const server = http.createServer(app);

// ✅ Socket.IO (exportado para usarlo desde routes/community.ts)
export const io = initSocket(server);

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:3000";

// ✅ CORS HTTP (IMPORTANTE: permitir x-user-email)
app.use(
  cors({
    origin: FRONTEND_ORIGIN,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-user-email"], // ✅ FIX
  })
);

// ✅ Preflight global
app.options(
  "*",
  cors({
    origin: FRONTEND_ORIGIN,
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "x-user-email"], // ✅ FIX
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  })
);

// Stripe webhook necesita raw body
app.post(
  "/billing/webhook",
  express.raw({ type: "application/json" }),
  billingWebhookHandler
);

// JSON para el resto
app.use(express.json());

const EMAIL_REGEX = /^[\w.+-]+@[\w-]+\.[\w.-]+$/i;

interface ContactRequestBody {
  name?: string;
  email?: string;
  projectType?: string;
  message?: string;
}

app.post(
  "/contact",
  async (req: Request<unknown, unknown, ContactRequestBody>, res: Response) => {
    const errors: Record<string, string> = {};
    const { name, email, projectType, message } = req.body || {};

    if (!name || !name.trim()) errors.name = "El nombre es obligatorio.";
    if (!email || !email.trim()) errors.email = "El email es obligatorio.";
    else if (!EMAIL_REGEX.test(email))
      errors.email = "El formato del email no es válido.";
    if (!message || !message.trim()) errors.message = "El mensaje es obligatorio.";

    if (Object.keys(errors).length > 0) return res.status(400).json({ errors });

    const payload: ContactMessage = {
      name: name!.trim(),
      email: email!.trim(),
      projectType: projectType?.trim(),
      message: message!.trim(),
    };

    try {
      await sendContactEmail(payload);
      return res
        .status(200)
        .json({ success: true, message: "Mensaje enviado correctamente" });
    } catch (error) {
      console.error("Error al enviar el correo:", error);
      return res.status(500).json({
        success: false,
        message: "No se pudo enviar el mensaje. Inténtalo más tarde.",
      });
    }
  }
);

app.use("/projects", projectsRouter);
app.use("/stripe", stripeRouter);
app.use("/billing", billingRouter);
app.use("/community", communityRouter);
app.use("/verification", verificationRouter);

const PORT = Number(process.env.PORT) || 4000;

async function startServer() {
  try {
    await connectMongo();
    server.listen(PORT, () => {
      console.log(`Servidor escuchando en http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("No se pudo iniciar el servidor:", error);
    process.exit(1);
  }
}

startServer();

export default app;
