import cors from 'cors';
import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import { sendContactEmail, ContactMessage } from './services/mailer';

dotenv.config();

const app = express();

app.use(express.json());
app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN || 'http://localhost:3000',
    methods: ['POST', 'OPTIONS'],
  })
);

const EMAIL_REGEX = /^[\w.+-]+@[\w-]+\.[\w.-]+$/i;

interface ContactRequestBody {
  name?: string;
  email?: string;
  projectType?: string;
  message?: string;
}

app.post('/contact', async (req: Request<unknown, unknown, ContactRequestBody>, res: Response) => {
  const errors: Record<string, string> = {};
  const { name, email, projectType, message } = req.body || {};

  if (!name || !name.trim()) {
    errors.name = 'El nombre es obligatorio.';
  }

  if (!email || !email.trim()) {
    errors.email = 'El email es obligatorio.';
  } else if (!EMAIL_REGEX.test(email)) {
    errors.email = 'El formato del email no es válido.';
  }

  if (!message || !message.trim()) {
    errors.message = 'El mensaje es obligatorio.';
  }

  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ errors });
  }

  const payload: ContactMessage = {
    name: name!.trim(),
    email: email!.trim(),
    projectType: projectType?.trim(),
    message: message!.trim(),
  };

  try {
    await sendContactEmail(payload);
    return res.status(200).json({ success: true, message: 'Mensaje enviado correctamente' });
  } catch (error) {
    console.error('Error al enviar el correo:', error);
    return res
      .status(500)
      .json({ success: false, message: 'No se pudo enviar el mensaje. Inténtalo más tarde.' });
  }
});

const PORT = Number(process.env.PORT) || 4000;
app.listen(PORT, () => {
  console.log(`Servidor de contacto escuchando en http://localhost:${PORT}`);
});

export default app;
