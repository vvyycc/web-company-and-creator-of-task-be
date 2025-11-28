import nodemailer from 'nodemailer';
import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

export interface ContactMessage {
  name: string;
  email: string;
  projectType?: string;
  message: string;
}

// === Vars de entorno para Gmail OAuth2 ===
const {
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  GMAIL_REFRESH_TOKEN,
  GMAIL_USER,
  CONTACT_RECIPIENT,
} = process.env;

if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN || !GMAIL_USER) {
  console.warn(
    '[mailer] Faltan variables de entorno de Gmail OAuth2. ' +
    'Revisa GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN y GMAIL_USER'
  );
}

// Usamos Google OAuth2 client para obtener accessToken a partir del refreshToken
const oAuth2Client = new google.auth.OAuth2(
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  'http://localhost' // el mismo redirect que usaste para sacar el refresh_token
);

if (GMAIL_REFRESH_TOKEN) {
  oAuth2Client.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
}

// Creamos el transporter dinámicamente (renueva accessToken cada vez)
async function getTransporter() {
  if (!GMAIL_USER || !GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error('Configuración de Gmail OAuth2 incompleta');
  }

  const { token } = await oAuth2Client.getAccessToken();
  if (!token) {
    throw new Error('No se pudo obtener un access token válido de Gmail');
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      type: 'OAuth2',
      user: GMAIL_USER,
      clientId: GMAIL_CLIENT_ID,
      clientSecret: GMAIL_CLIENT_SECRET,
      refreshToken: GMAIL_REFRESH_TOKEN,
      accessToken: token,
    },
  });

  return transporter;
}

export const sendContactEmail = async (payload: ContactMessage): Promise<void> => {
  const { name, email, projectType, message } = payload;

  const subject = `Nuevo contacto: ${name}${projectType ? ` - ${projectType}` : ''}`;
  const body = [
    'Se ha recibido un nuevo mensaje desde el formulario de contacto.',
    '',
    `Nombre: ${name}`,
    `Email: ${email}`,
    `Tipo de proyecto: ${projectType ?? 'No especificado'}`,
    '',
    'Mensaje:',
    message,
  ].join('\n');

  const transporter = await getTransporter();

  await transporter.sendMail({
    from: `"Automation Backend" <${GMAIL_USER}>`,
    to: CONTACT_RECIPIENT || GMAIL_USER,
    subject,
    text: body,
  });
};
