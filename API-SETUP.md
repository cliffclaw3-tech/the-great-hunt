# eBay API Setup — The Great Hunt

This app now supports real eBay Browse API lookups and Reverb API lookups for `/api/lookup`.

## What Wes needs
Create eBay developer app credentials, then add them to a local `.env` file.

## Step 1 — Create an eBay developer account
1. Go to https://developer.ebay.com/
2. Sign in with an existing eBay account or create one
3. Open the Developer Dashboard

## Step 2 — Create an application keyset
1. In the dashboard, create a new application if prompted
2. Generate keys for the environment you want to test:
   - **Sandbox** = safest for initial wiring checks
   - **Production** = real marketplace data
3. Copy these two values:
   - **Client ID**
   - **Client Secret**

## Step 3 — Create your local `.env`
In `/Users/wes/Projects/The Great Hunt`, create a file named `.env`.

Start from `.env.example` and fill in the real values:

```env
EBAY_CLIENT_ID=your-real-client-id
EBAY_CLIENT_SECRET=your-real-client-secret
EBAY_ENV=production
EBAY_ENABLE_MARKETPLACE_INSIGHTS=false
REVERB_TOKEN=your-real-reverb-token
OPENAI_API_KEY=your-openai-api-key
OPENAI_VISION_MODEL=gpt-4.1-mini
UPCITEMDB_USER_KEY=
BARCODE_LOOKUP_API_KEY=
BETA_ACCESS_CODE=choose-a-private-beta-code
APP_PUBLIC_URL=https://thegreathunt.io
HOST=0.0.0.0
PORT=4173
```

Use `EBAY_ENV=sandbox` if you want to test against sandbox first.

## Step 4 — Install dependencies
From the project folder:

```bash
npm install
```

## Step 5 — Start the app
```bash
npm start
```

The app runs at:
- http://127.0.0.1:4173

For a public Node host, use:

```bash
npm run start:production
```

Production should have:

```env
NODE_ENV=production
HOST=0.0.0.0
APP_PUBLIC_URL=https://thegreathunt.io
```

## Health check
After the app starts, open:

- `http://127.0.0.1:4173/api/health`

The health check does not show secrets. It reports whether the app server is responding and whether the beta-critical pieces are configured:

- Server
- Beta access code
- eBay active comps
- Photo ID
- Smart page scan
- eBay sold comps
- Public beta URL
- Saved tester examples

For local development, it is normal for **Public beta URL** and **Sold comps** to say they still need work. Before outside testers, set `APP_PUBLIC_URL` to the deployed app URL, ideally `https://thegreathunt.io`.

## What to expect
- If eBay credentials are present and valid, the lookup tool will use live eBay Browse API search results.
- If eBay grants Marketplace Insights access, set `EBAY_ENABLE_MARKETPLACE_INSIGHTS=true` to try eBay sold-comps before active listings.
- If `REVERB_TOKEN` is present and the category is Vintage audio or Instruments, the lookup tool tries Reverb first.
- Photo assessment is wired into the app for beta testing. A vision model key will be needed before the app can identify an object from the photo alone.
- Radar can use Crawl4AI for smarter estate-sale, auction, and classifieds page scans when Crawl4AI is installed. If it is not installed, Radar falls back to the basic scanner.
- If credentials are missing, invalid, or eBay returns no usable results, the app falls back to the existing local estimate behavior.
- Front-end behavior stays the same: photo card, comp links, rare fact, and disclaimer still render.

## Crawl4AI smart page scan
Crawl4AI is optional. It helps Radar turn messy web pages into cleaner text before The Great Hunt looks for promising items.

Local setup:

```bash
python3 -m pip install crawl4ai
python3 -m crawl4ai-setup
```

Optional `.env` values:

```env
CRAWL4AI_ENABLED=true
CRAWL4AI_PYTHON=python3
CRAWL4AI_TIMEOUT_MS=22000
```

If the package or browser runtime is missing on a host, the app keeps working and uses the basic source scanner instead.

## Barcode/product lookup setup
Barcode photos only contain a number. The app now tries to turn that number into a product name before running comps.

Built-in fallbacks:
- UPCitemdb trial lookup, no key required but limited
- Open Products Facts / Open Food Facts, no key required but coverage varies

Optional broader coverage:

```env
UPCITEMDB_USER_KEY=your-upcitemdb-key
BARCODE_LOOKUP_API_KEY=your-barcode-lookup-key
```

Current flow:
1. Vision reads UPC/EAN digits from the tag or package photo
2. Product lookup APIs try to match the barcode to a product
3. The app uses the matched brand/title/barcode as search terms
4. The normal comp flow estimates value and shows the barcode lookup result

## Photo assessment setup
For the beta, photos can be attached to a field check and shown at the top of the result. The app now has an **Identify** button beside the attached photo.

To identify objects from the image itself, add a vision-capable OpenAI API key. The easiest local path is:

1. Start the app
2. Open `http://127.0.0.1:4173/setup.html`
3. Paste the OpenAI API key into **Connect Vision**
4. Leave the model as `gpt-4.1-mini` unless testing a different model

```env
OPENAI_API_KEY=your-openai-api-key
OPENAI_VISION_MODEL=gpt-4.1-mini
```

Once enabled, the intended flow is:
1. User takes a photo in the field
2. Vision identifies likely item, category, maker/model, visible condition, and search terms
3. App runs comps through eBay/Reverb/other sources
4. User sees estimate, fast-sale price, competition, comp links, and condition warnings

## Reverb setup
1. Go to https://www.reverb-api.com/docs/authentication
2. Sign in to Reverb
3. Open your user menu, then My Profile
4. Open API & Integrations
5. Generate a token named `The Great Hunt`
6. Use minimal scopes for now:
   - `public`
   - `read_listings`
7. Add the token to `.env` as `REVERB_TOKEN=...`

## eBay sold-comps setup
eBay sold comps require Marketplace Insights API access. This is a limited-release API, so normal Browse API keys may not be enough.

Request access for:
- API: Marketplace Insights API
- Scope: `https://api.ebay.com/oauth/api_scope/buy.marketplace.insights`
- Use case: resale research and comparable-price lookup for public marketplace data

Once eBay grants access, change this in `.env`:

```env
EBAY_ENABLE_MARKETPLACE_INSIGHTS=true
```

Until then, leave it as `false` so the app continues using active eBay Browse API listings.

## Sandbox vs production
### Sandbox
Use when you just want to confirm auth and request wiring.
- `EBAY_ENV=sandbox`
- Lower risk
- Data may not be as useful for real comps

### Production
Use when you want real listing data for actual lookup decisions.
- `EBAY_ENV=production`
- Best for real testing in this app

## Notes
- This integration uses eBay’s official OAuth client-credentials flow.
- No scraping is used.
- Browse API results are filtered to remove obvious bad comps like broken/parts/reproduction/lot listings where possible.
