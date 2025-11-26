import nodemailer from 'nodemailer';

export interface ContactMessage {
  name: string;
  email: string;
  projectType?: string;
  message: string;
}

const smtpHost = process.env.SMTP_HOST;
const smtpPort = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined;
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;
const contactRecipient = process.env.CONTACT_RECIPIENT;

const transporter = nodemailer.createTransport({
  host: smtpHost,
  port: smtpPort,
  secure: smtpPort === 465,
  auth: smtpUser && smtpPass ? { user: smtpUser, pass: smtpPass } : undefined,
});

export const sendContactEmail = async (payload: ContactMessage): Promise<void> => {
  const { name, email, projectType, message } = payload;
  const subject = `Nuevo contacto: ${name}${projectType ? ` - ${projectType}` : ''}`;
  const body = [
    'Se ha recibido un nuevo mensaje desde el formulario de contacto.',
    '',
    `Nombre: ${name}`,
    `Email: ${email}`,
    `Tipo de proyecto: ${projectType ?? 'No especificado'}`,
    'Mensaje:',
    message,
  ].join('\n');

  await transporter.sendMail({
    from: smtpUser || contactRecipient,
    to: contactRecipient,
    subject,
    text: body,
  });
};
