# web-company-and-creator-of-task-be

Backend en Node.js/Express para gestionar el formulario de contacto de la web estática. Expone un endpoint `POST /contact` que valida los campos y envía un correo a la empresa mediante Nodemailer.

## Requisitos
- Node.js 18+
- Variables de entorno configuradas (ver `.env.example`).

## Instalación y uso
```
npm install
npm run dev
```
El servidor se levanta por defecto en `http://localhost:4000` y permite CORS desde `FRONTEND_ORIGIN` o `http://localhost:3000`.

## Variables de entorno
Copia `.env.example` a `.env` y ajusta los valores:
- `PORT`: Puerto de escucha (por defecto 4000).
- `FRONTEND_ORIGIN`: Dominio permitido para CORS.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`: Credenciales SMTP.
- `CONTACT_RECIPIENT`: Correo de destino donde se reciben los mensajes.
- `MONGO_URI`: Cadena de conexión a MongoDB.
- `STRIPE_SECRET_KEY`, `STRIPE_SUBSCRIPTION_PRICE_ID`, `STRIPE_SUBSCRIPTION_SUCCESS_URL`, `STRIPE_SUBSCRIPTION_CANCEL_URL`, `STRIPE_WEBHOOK_SECRET`: Configuración de Stripe para la suscripción mensual de 30 €.
