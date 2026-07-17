/**
 * Voco AI Backend Server
 * --------------------------------------------------
 * Responsibilities:
 *  1. Create a Razorpay SUBSCRIPTION (server-side, using trusted plan config)
 *     with a 1-day free trial before the first charge — and auto-pay every
 *     month after that, since the person authorizes it once at signup.
 *  2. Verify the payment signature Razorpay sends back after checkout.
 *
 * Why subscriptions instead of one-time orders:
 * A one-time order only charges once. To offer "1 day free, then ₹99/month
 * auto-pay", Razorpay needs a Subscription, which is billed on a recurring
 * schedule against a Plan you create in your Razorpay Dashboard. The trial
 * is implemented by setting the subscription's start_at to 1 day in the
 * future — the customer authorizes their card/UPI now (usually via a small
 * authorization charge that's refunded), and the real charge only happens
 * when the trial ends.
 *
 * IMPORTANT SETUP STEP (do this before going live):
 * You must create 3 Plans in your Razorpay Dashboard → Subscriptions → Plans
 * (one for each of Starter/Pro/Premium, billed monthly), then paste their
 * plan_id values into your .env file. This code cannot create Plans for you
 * because Plans are account-level configuration, not something that should
 * be generated on every request.
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Razorpay = require('razorpay');
require('dotenv').config();

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// CORS: only allow requests from domains you control (set in .env)
// ---------------------------------------------------------------------------
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
  })
);

// ---------------------------------------------------------------------------
// Razorpay instance (uses your account's key id + secret)
// ---------------------------------------------------------------------------
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ---------------------------------------------------------------------------
// Source of truth for plans. The Razorpay plan_id must be created in your
// Dashboard first (Subscriptions → Plans → New Plan, billing cycle: monthly,
// amount matching the price below), then pasted into .env.
// ---------------------------------------------------------------------------
const PLANS = {
  starter: {
    name: 'Starter Plan',
    priceLabel: '₹99/month',
    razorpayPlanId: process.env.RAZORPAY_PLAN_STARTER,
  },
  pro: {
    name: 'Pro Plan',
    priceLabel: '₹199/month',
    razorpayPlanId: process.env.RAZORPAY_PLAN_PRO,
  },
  premium: {
    name: 'Premium Plan',
    priceLabel: '₹499/month',
    razorpayPlanId: process.env.RAZORPAY_PLAN_PREMIUM,
  },
};

const TRIAL_DAYS = 1;

// In-memory map of subscription.id -> planId, so at verification time we
// know which plan this subscription is actually for. In production, replace
// this with a real database table (subscriptions: id, plan_id, status,
// customer, created_at...) so it survives server restarts.
const subscriptionPlanMap = new Map();

/**
 * POST /api/create-subscription
 * Body: { planId: "starter" | "pro" | "premium" }
 * Returns: { subscriptionId, keyId, planName }
 */
app.post('/api/create-subscription', async (req, res) => {
  try {
    const { planId } = req.body;
    const plan = PLANS[planId];

    if (!plan) {
      return res.status(400).json({ error: 'Invalid plan selected.' });
    }
    if (!plan.razorpayPlanId) {
      // This means the .env file is missing the Razorpay plan_id for this
      // plan — see the setup note at the top of this file.
      return res.status(500).json({
        error: `No Razorpay plan_id configured for "${planId}". Add it to your .env file.`,
      });
    }

    // Trial ends 1 day from now — the first real charge happens then.
    const startAt = Math.floor(Date.now() / 1000) + TRIAL_DAYS * 24 * 60 * 60;

    const subscription = await razorpay.subscriptions.create({
      plan_id: plan.razorpayPlanId,
      customer_notify: 1,
      total_count: 120, // max monthly charges before it must be recreated (10 years); the customer can cancel anytime
      start_at: startAt,
      notes: { planId, planName: plan.name },
    });

    subscriptionPlanMap.set(subscription.id, planId);

    res.json({
      subscriptionId: subscription.id,
      keyId: process.env.RAZORPAY_KEY_ID,
      planName: plan.name,
    });
  } catch (err) {
    console.error('Error creating subscription:', err);
    res.status(500).json({ error: 'Could not start your free trial. Please try again.' });
  }
});

/**
 * POST /api/verify-subscription
 * Body: {
 *   razorpay_payment_id, razorpay_subscription_id, razorpay_signature,
 *   customer: { fullName, email, phone, role, experience, location }
 * }
 * Returns: { verified: true, whatsappMessage } or 400 if verification fails
 */
app.post('/api/verify-subscription', (req, res) => {
  try {
    const {
      razorpay_payment_id,
      razorpay_subscription_id,
      razorpay_signature,
      customer = {},
    } = req.body;

    if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment details.' });
    }

    // Razorpay's subscription signature formula is payment_id + "|" +
    // subscription_id — note the order is different from the one-time
    // order flow (which is order_id + "|" + payment_id).
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
      .digest('hex');

    const isValid = expectedSignature === razorpay_signature;

    if (!isValid) {
      return res.status(400).json({ verified: false, error: 'Payment verification failed.' });
    }

    const planId = subscriptionPlanMap.get(razorpay_subscription_id);
    const plan = PLANS[planId];

    if (!plan) {
      return res.status(400).json({ verified: false, error: 'Unknown subscription.' });
    }

    const whatsappMessage =
      `Hello!\n` +
      `I have started my 1-day free trial for the ${plan.name} (${plan.priceLabel} after trial, auto-pay).\n\n` +
      `My Name: ${customer.fullName || ''}\n` +
      `Email: ${customer.email || ''}\n` +
      `Phone: ${customer.phone || ''}\n` +
      `Preferred Role: ${customer.role || ''}\n` +
      `Experience: ${customer.experience || ''}\n` +
      `Preferred Location: ${customer.location || ''}\n` +
      `Subscription ID: ${razorpay_subscription_id}\n\n` +
      `I am ready to share my resume.`;

    subscriptionPlanMap.delete(razorpay_subscription_id);

    res.json({ verified: true, whatsappMessage });
  } catch (err) {
    console.error('Error verifying subscription payment:', err);
    res.status(500).json({ error: 'Something went wrong during verification.' });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Voco AI backend running on http://localhost:${PORT}`);
});
