import { Router, Request, Response } from 'express';
import { stripeClient } from '../config/stripe';

const router = Router();

router.post('/checkout-session', async (_req: Request, res: Response) => {
  if (!stripeClient) {
    return res.status(500).json({ error: 'Stripe no está configurado correctamente' });
  }

  if (!process.env.STRIPE_PRICE_ID || !process.env.STRIPE_SUCCESS_URL || !process.env.STRIPE_CANCEL_URL) {
    return res.status(500).json({ error: 'Faltan variables de entorno de Stripe' });
  }

  try {
    const session = await stripeClient.checkout.sessions.create({
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      mode: 'payment',
      success_url: process.env.STRIPE_SUCCESS_URL,
      cancel_url: process.env.STRIPE_CANCEL_URL,
    });

    return res.status(200).json({ id: session.id, url: session.url });
  } catch (error) {
    console.error('Error creando sesión de Checkout:', error);
    return res.status(500).json({ error: 'No se pudo crear la sesión de pago' });
  }
});

export default router;
