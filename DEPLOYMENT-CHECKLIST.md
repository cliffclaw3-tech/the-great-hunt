# The Great Hunt Deployment Checklist

Use this when moving the beta from local development to a public URL.

## Required before inviting outside testers

1. Deploy the Node app to a public host.
2. Point `thegreathunt.io` or a temporary Hostinger URL at the deployed app.
3. Set production environment variables:

```env
NODE_ENV=production
HOST=0.0.0.0
PORT=your-host-provided-port
APP_PUBLIC_URL=https://thegreathunt.io
BETA_ACCESS_CODE=your-private-beta-code
EBAY_ENV=production
EBAY_CLIENT_ID=your-ebay-client-id
EBAY_CLIENT_SECRET=your-ebay-client-secret
EBAY_ENABLE_MARKETPLACE_INSIGHTS=false
REVERB_TOKEN=your-reverb-token
OPENAI_API_KEY=your-openai-api-key
OPENAI_VISION_MODEL=gpt-4.1-mini
```

4. Start command:

```bash
npm run start:production
```

5. Open the health check:

```text
https://thegreathunt.io/api/health
```

## Expected beta health

These should pass before testers use it:

- Server
- Beta access
- eBay active comps
- Photo ID
- Public URL

These may still be in progress:

- Sold comps, until eBay approves Marketplace Insights
- Tester examples, until real beta finds are saved

## Tester handoff

In the app, open Queue, then use **Copy tester guide** from the beta checklist.

## Add to phone home screen

After the app is deployed at a public HTTPS URL:

### iPhone

1. Open the app in Safari.
2. Tap the Share button.
3. Tap **Add to Home Screen**.
4. Name it **Great Hunt**.
5. Tap **Add**.

### Android

1. Open the app in Chrome.
2. Tap the menu button.
3. Tap **Add to Home screen** or **Install app**.
4. Name it **Great Hunt**.
5. Tap **Add**.

The app now includes a web app manifest, app icon, theme color, and service worker so it can behave like a simple installed phone app once hosted publicly.

Remind testers:

- Prices are estimates, not a guarantee of profit.
- Active listings are not the same as sold comps.
- Upload/take photos when possible.
- Save interesting finds to the queue.
- Mark bad results as Wrong item, Bad comps, or Too confusing.
- Do not meet strangers alone with lots of cash.
