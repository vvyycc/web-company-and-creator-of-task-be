import { Schema, model, models } from 'mongoose';

const SubscriptionSchema = new Schema(
  {
    email: { type: String, required: true, index: true },
    stripeCustomerId: { type: String, required: true },
    stripeSubscriptionId: { type: String, required: true, unique: true },
    status: { type: String, required: true }, // 'active', 'canceled', 'incomplete', etc.
  },
  { timestamps: true }
);

export const Subscription = models.Subscription || model('Subscription', SubscriptionSchema);

