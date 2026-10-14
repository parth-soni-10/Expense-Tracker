#!/usr/bin/env node
/**
 * Generates a VAPID keypair for the daily-reminder Web Push and prints the
 * exact secrets to put on the Worker (npx wrangler secret put <name>), and
 * variables). Run once per site; keep the private key secret.
 *
 *   node scripts/generate-vapid-keys.mjs
 *
 * Why VAPID: push services require a signed proof (RFC 8292) that the sender
 * owns the subscription's application server key. The public key is shared
 * with browsers (they bind subscriptions to it), the private key stays in
 * the functions the Worker bundles and signs every outgoing push.
 */
import { generateVapidKeys } from '../netlify/functions/lib/webpush.mjs';

const keys = generateVapidKeys();
console.log('Add these as secrets on the Worker (npx wrangler secret put <name>):\n');
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log(`VAPID_SUBJECT=mailto:you@example.com`);
console.log('\nKeep the private key secret — anyone holding it can send pushes');
console.log('to every subscribed browser as this site.');
