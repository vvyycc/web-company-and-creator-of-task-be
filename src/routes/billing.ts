import express, { Request, Response } from 'express';
import Stripe from 'stripe';
import { connectMongo } from '../db/mongo';
import { Subscription } from '../models/Subscription';

const router = express.Router();
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
if (!stripeSecretKey) {
  console.warn('[billing] STRIPE_SECRET_KEY no está definido. Stripe no funcionará.');
}
const stripeClient = stripeSecretKey ? new Stripe(stripeSecretKey): null;

/**
 * POST /billing/create-subscription-session
 * Crea una sesión de checkout de Stripe en modo suscripción (30 €/mes).
 */
router.post('/create-subscription-session', async (req: Request, res: Response) => {
  const { email } = req.body || {};

  if (!email) {
    return res
      .status(400)
      .json({ error: 'El email es obligatorio para crear la suscripción' });
  }

  if (!stripeClient) {
    res.status(500).json({ error: 'Stripe no está configurado correctamente' });
    return;
  }

  const {
    STRIPE_SUBSCRIPTION_PRICE_ID,
    STRIPE_SUBSCRIPTION_SUCCESS_URL,
    STRIPE_SUBSCRIPTION_CANCEL_URL,
  } = process.env;

  if (
    !STRIPE_SUBSCRIPTION_PRICE_ID ||
    !STRIPE_SUBSCRIPTION_SUCCESS_URL ||
    !STRIPE_SUBSCRIPTION_CANCEL_URL
  ) {
    return res
      .status(500)
      .json({ error: 'Faltan variables de entorno de Stripe para la suscripción' });
  }

  try {
    await connectMongo();

    const session = await stripeClient.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email,
      line_items: [{ price: STRIPE_SUBSCRIPTION_PRICE_ID, quantity: 1 }],
      success_url: `${STRIPE_SUBSCRIPTION_SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: STRIPE_SUBSCRIPTION_CANCEL_URL,
    });

    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error('Error creando sesión de suscripción:', error);
    return res
      .status(500)
      .json({ error: 'No se pudo crear la sesión de suscripción' });
  }
});

/**
 * GET /billing/confirm-subscription?session_id=...
 * Confirma la sesión de Stripe y registra/actualiza la suscripción en Mongo.
 */
router.get('/confirm-subscription', async (req: Request, res: Response) => {
  if (!stripeClient) {
    res.status(500).json({ error: 'Stripe no está configurado correctamente' });
    return;
  }

  const sessionId = req.query.session_id as string | undefined;
  if (!sessionId) {
    return res.status(400).json({ error: 'Falta session_id' });
  }

  try {
    await connectMongo();

    const session = await stripeClient.checkout.sessions.retrieve(sessionId);

    if (session.mode !== 'subscription') {
      return res
        .status(400)
        .json({ error: 'La sesión no es de tipo suscripción' });
    }

    const subscriptionId = session.subscription?.toString();
    const customerId =
      typeof session.customer === 'string'
        ? session.customer
        : session.customer?.id;

    let customerEmail = session.customer_email;

    if (!customerEmail && customerId) {
      const customer = await stripeClient.customers.retrieve(customerId);
      if (!('deleted' in customer)) {
        customerEmail = customer.email ?? null;
      }
    }

    if (!subscriptionId || !customerId || !customerEmail) {
      return res
        .status(400)
        .json({ error: 'No se pudo obtener info de la suscripción' });
    }

    const dbSub = await Subscription.findOneAndUpdate(
      { stripeSubscriptionId: subscriptionId },
      {
        email: customerEmail,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        status: 'active',
      },
      { upsert: true, new: true }
    );

    return res.json({
      ok: true,
      subscription: {
        email: dbSub.email,
        status: dbSub.status,
        stripeCustomerId: dbSub.stripeCustomerId,
        stripeSubscriptionId: dbSub.stripeSubscriptionId,
      },
    });
  } catch (error) {
    console.error('Error confirmando suscripción:', error);
    return res
      .status(500)
      .json({ error: 'No se pudo confirmar la suscripción' });
  }
});

/**
 * GET /billing/me-subscription?email=...
 * Devuelve si el usuario tiene una suscripción activa.
 */
router.get('/me-subscription', async (req: Request, res: Response) => {
  const email = req.query.email as string | undefined;

  if (!email) {
    return res.status(400).json({ error: 'El email es obligatorio' });
  }

  try {
    await connectMongo();
    const subscription = await Subscription.findOne({ email });

    if (!subscription) {
      return res.status(200).json({ hasActiveSubscription: false });
    }

    return res.status(200).json({
      hasActiveSubscription: subscription.status === 'active',
      status: subscription.status,
    });
  } catch (error) {
    console.error('Error consultando suscripción:', error);
    return res
      .status(500)
      .json({ error: 'No se pudo consultar la suscripción' });
  }
});

/**
 * POST /billing/create-project-payment-session
 * Crea un pago único (mode: payment) para publicar el proyecto en la comunidad.
 * Body: { email, amount, projectTitle }
 */
router.post(
  '/create-project-payment-session',
  async (req: Request, res: Response) => {
    if (!stripeClient) {
      res.status(500).json({ error: 'Stripe no está configurado correctamente' });
      return;
    }

    const { email, amount, projectTitle } = req.body || {};

    if (!email || typeof amount !== 'number' || !projectTitle) {
      return res
        .status(400)
        .json({ error: 'Faltan datos para el pago del proyecto' });
    }

    const { STRIPE_PROJECT_SUCCESS_URL, STRIPE_PROJECT_CANCEL_URL } =
      process.env;

    if (!STRIPE_PROJECT_SUCCESS_URL || !STRIPE_PROJECT_CANCEL_URL) {
      return res
        .status(500)
        .json({ error: 'Faltan URLs de Stripe para el pago de proyecto' });
    }

    try {
      const unitAmount = Math.round(amount * 100); // euros -> céntimos

      const session = await stripeClient.checkout.sessions.create({
        mode: 'payment',
        customer_email: email,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'eur',
              unit_amount: unitAmount,
              product_data: {
                name: `Proyecto: ${projectTitle}`,
              },
            },
          },
        ],
        success_url: `${STRIPE_PROJECT_SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: STRIPE_PROJECT_CANCEL_URL,
      });

      return res.json({ url: session.url });
    } catch (error) {
      console.error('Error creando sesión de pago de proyecto:', error);
      return res
        .status(500)
        .json({ error: 'No se pudo crear el pago del proyecto' });
    }
  }
);
export async function billingWebhookHandler(req: Request, res: Response) {
  if (!stripeClient || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(500).send('Stripe no está configurado correctamente');
  }

  const sig = req.headers['stripe-signature'];

  if (!sig) {
    return res.status(400).send('Falta la firma de Stripe');
  }

  let event: Stripe.Event;

  try {
    event = stripeClient.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Firma de webhook inválida', err);
    return res.status(400).send('Firma inválida');
  }

  try {
    await connectMongo();

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;

        if (session.mode !== 'subscription') break;

        const subscriptionId = session.subscription?.toString();
        const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
        let customerEmail = session.customer_email;

        if (!customerEmail && customerId) {
          const customer = await stripeClient.customers.retrieve(customerId);
          if (!('deleted' in customer)) {
            customerEmail = customer.email ?? null;
          }
        }

        if (!subscriptionId || !customerId || !customerEmail) break;

        await Subscription.findOneAndUpdate(
          { stripeSubscriptionId: subscriptionId },
          {
            email: customerEmail,
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscriptionId,
            status: 'active',
          },
          { upsert: true, new: true }
        );

        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        await Subscription.findOneAndUpdate(
          { stripeSubscriptionId: subscription.id },
          {
            stripeCustomerId: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id,
            status: subscription.status,
          }
        );
        break;
      }
      default:
        break;
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('Error procesando webhook de Stripe:', error);
    return res.status(500).send('Error interno procesando webhook');
  }
}

export default router;

