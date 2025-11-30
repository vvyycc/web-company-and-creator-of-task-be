import Stripe from 'stripe';

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

export const stripeClient = stripeSecretKey
  ? new Stripe(stripeSecretKey, { apiVersion: Stripe.LatestApiVersion })
  : null;

